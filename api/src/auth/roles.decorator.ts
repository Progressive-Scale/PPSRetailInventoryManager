import { Reflector } from '@nestjs/core';
import { Role } from './auth.types';

/** Restrict a handler/controller to specific roles. */
export const Roles = Reflector.createDecorator<Role[]>();
