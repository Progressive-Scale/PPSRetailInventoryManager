import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash } from 'bcryptjs';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { companies, passwordResets, User, users } from '../db/schema';
import { HostContext } from '../tenancy/tenant-context';
import { MailService, PRODUCT_NAME } from '../mail/mail.service';
import { AuthService } from './auth.service';
import {
  buildResetUrl,
  generateResetToken,
  hashResetToken,
  REVEAL_UNKNOWN_EMAIL,
  RESET_TTL_MINUTES,
  resetExpiry,
  resetState,
  ResetState,
  resetStateMessage,
} from './password-reset.util';

/**
 * Forgotten-password flow. Three unauthenticated steps: request a link, check the
 * link, redeem it.
 *
 * The whole flow is scoped by HOST. A request on demo.example.com can only ever
 * find, and reset, a Demo user — even if the same address exists in another
 * company. Platform admins live on the admin host and are handled under
 * withBypass, since they have no company to scope to.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  /** Same host→scope decision the login path makes. */
  private run<T>(host: HostContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (host.kind === 'admin') return this.tenantDb.withBypass(work);
    if (host.kind === 'company') {
      return this.tenantDb.withCompany(host.company.id, work);
    }
    throw new BadRequestException('Invalid host for a password reset.');
  }

  async request(host: HostContext, rawEmail: string): Promise<{ sent: boolean }> {
    const email = rawEmail.trim().toLowerCase();

    return this.run(host, async (tx) => {
      const conds = [eq(users.email, email)];
      // On the admin host only a platform admin can reset; a tenant user must use
      // their own company host.
      if (host.kind === 'admin') {
        conds.push(eq(users.role, 'PLATFORM_ADMIN'), isNull(users.companyId));
      }
      const [user] = await tx
        .select()
        .from(users)
        .where(and(...conds))
        .limit(1);

      // A suspended account is treated as absent: it cannot log in, so handing it a
      // working reset link would be misleading.
      if (!user || user.status !== 'ACTIVE') {
        if (REVEAL_UNKNOWN_EMAIL) {
          throw new NotFoundException(
            'No active account was found with that email address.',
          );
        }
        // Privacy-preserving branch: look identical to success and send nothing.
        return { sent: true };
      }

      // Only the newest link may work. Without this, an older email in the inbox
      // stays redeemable, which is exactly the window an attacker with stale
      // mailbox access wants.
      await this.supersedeOutstanding(tx, user.id);

      const token = generateResetToken();
      const expiresAt = resetExpiry();
      await tx.insert(passwordResets).values({
        companyId: user.companyId,
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt,
      });

      const companyName = await this.companyNameFor(tx, user);
      const resetUrl = buildResetUrl({
        slug: host.kind === 'company' ? host.company.slug : null,
        rootDomain: this.config.get<string>('ROOT_DOMAIN') ?? 'yourapp.local',
        token,
        baseUrlOverride: this.config.get<string>('APP_BASE_URL') || undefined,
      });

      const result = await this.mail.sendPasswordResetEmail(user.email, {
        companyName,
        username: user.username,
        resetUrl,
        expiresAt,
        ttlMinutes: RESET_TTL_MINUTES,
      });

      // A failed send is logged, not surfaced. Telling the caller "we could not
      // email you" leaks that the address exists even in the privacy-preserving
      // mode, and there is nothing they could do about it anyway.
      if (!result.ok) {
        this.logger.error(
          `Password reset email to ${user.email} failed — ${result.error ?? 'unknown'}`,
        );
      }
      return { sent: true };
    });
  }

  /**
   * Platform-admin variant: issue a reset link FOR a named tenant user, when they
   * cannot use the self-service flow (wrong address on file, no access to the
   * mailbox, tenant admin unavailable). Runs under bypass because the caller has
   * no company of their own.
   *
   * Unlike `request`, this returns the link to the CALLER. That is deliberate — the
   * point is to be able to read it out to someone whose email is the problem — and
   * it is why the endpoint behind it is platform-admin only. The email still goes
   * out, so the ordinary path works when the mailbox does.
   */
  async issueForUser(userId: number): Promise<{
    userId: number;
    email: string;
    username: string;
    resetUrl: string;
    expiresAt: Date;
    emailSent: boolean;
    emailError: string | null;
  }> {
    return this.tenantDb.withBypass(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new NotFoundException('User not found.');
      if (user.role === 'PLATFORM_ADMIN' || user.companyId == null) {
        throw new BadRequestException(
          'Platform-admin accounts reset their own password from the admin host.',
        );
      }
      // A suspended account cannot log in, so a working link would be misleading —
      // reactivate first, then reset.
      if (user.status !== 'ACTIVE') {
        throw new BadRequestException(
          'This account is suspended. Reactivate it before issuing a reset link.',
        );
      }

      const [company] = await tx
        .select({ name: companies.name, slug: companies.slug })
        .from(companies)
        .where(eq(companies.id, user.companyId))
        .limit(1);
      if (!company) throw new NotFoundException('Company not found.');

      // Only the newest link may work, exactly as in the self-service flow.
      await this.supersedeOutstanding(tx, user.id);

      const token = generateResetToken();
      const expiresAt = resetExpiry();
      await tx.insert(passwordResets).values({
        companyId: user.companyId,
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt,
      });

      // The link lands on the USER's company host, not the admin host — that is
      // where their account lives and where the reset page can find the token.
      const resetUrl = buildResetUrl({
        slug: company.slug,
        rootDomain: this.config.get<string>('ROOT_DOMAIN') ?? 'yourapp.local',
        token,
        baseUrlOverride: this.config.get<string>('APP_BASE_URL') || undefined,
      });

      const result = await this.mail.sendPasswordResetEmail(user.email, {
        companyName: company.name,
        username: user.username,
        resetUrl,
        expiresAt,
        ttlMinutes: RESET_TTL_MINUTES,
      });
      if (!result.ok) {
        this.logger.error(
          `Admin-issued reset email to ${user.email} failed — ${result.error ?? 'unknown'}`,
        );
      }

      return {
        userId: user.id,
        email: user.email,
        username: user.username,
        resetUrl,
        expiresAt,
        emailSent: result.ok,
        emailError: result.ok ? null : (result.error ?? 'send failed'),
      };
    });
  }

  /** Lifecycle of a presented token, for the reset page to render before asking. */
  async status(
    host: HostContext,
    token: string,
  ): Promise<{ state: ResetState; message: string; username?: string }> {
    return this.run(host, async (tx) => {
      const [row] = await tx
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, hashResetToken(token)))
        .limit(1);
      const state = resetState(row);
      if (state !== 'VALID') return { state, message: resetStateMessage(state) };

      const [user] = await tx
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1);
      return { state, message: '', username: user?.username };
    });
  }

  /**
   * Redeem the link. Re-validated here rather than trusting the status call, since
   * a link can expire or be superseded between page load and submit. Signs the user
   * in on success so they are not immediately asked to type the password again.
   */
  async reset(host: HostContext, token: string, newPassword: string) {
    return this.run(host, async (tx) => {
      const [row] = await tx
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.tokenHash, hashResetToken(token)))
        .limit(1);

      const state = resetState(row);
      if (state !== 'VALID') {
        const message = resetStateMessage(state);
        if (state === 'INVALID') throw new NotFoundException(message);
        throw new BadRequestException(message);
      }

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1);
      if (!user || user.status !== 'ACTIVE') {
        throw new BadRequestException(
          'This account is no longer active. Contact your administrator.',
        );
      }

      await tx
        .update(users)
        .set({ passwordHash: await hash(newPassword, 10) })
        .where(eq(users.id, user.id));

      // Burn this link, and any sibling that somehow survived, in the same
      // transaction as the password change.
      await tx
        .update(passwordResets)
        .set({ usedAt: new Date() })
        .where(eq(passwordResets.id, row.id));
      await this.supersedeOutstanding(tx, user.id, row.id);

      // Signed in on the same transaction, so the permitted-store list the response
      // carries is the committed one and a multi-store user still gets their picker.
      return this.auth.issueSessionFor(user, tx);
    });
  }

  /** Marks every still-live reset for a user as superseded. */
  private async supersedeOutstanding(
    tx: Tx,
    userId: number,
    exceptId?: number,
  ): Promise<void> {
    await tx
      .update(passwordResets)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(passwordResets.userId, userId),
          isNull(passwordResets.usedAt),
          isNull(passwordResets.supersededAt),
          ...(exceptId != null ? [ne(passwordResets.id, exceptId)] : []),
        ),
      );
  }

  /** Platform admins have no company, so the product name stands in. */
  private async companyNameFor(tx: Tx, user: User): Promise<string> {
    if (user.companyId == null) return PRODUCT_NAME;
    const [company] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, user.companyId))
      .limit(1);
    return company?.name ?? PRODUCT_NAME;
  }
}
