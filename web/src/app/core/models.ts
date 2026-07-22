export type Role = 'ADMIN' | 'STORE_USER';

export interface AuthUser {
  id: number;
  email: string;
  storeId: number | null;
  role: Role;
}

export interface LoginResponse {
  access_token: string;
  user: AuthUser;
}

export interface InventoryItem {
  id: string;
  storeId: number;
  sku: string;
  name: string;
  description: string | null;
  quantity: number;
  // numeric is serialized as a string by the API.
  price: string;
  updatedAt: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface CreateInventoryItem {
  sku: string;
  name: string;
  description?: string;
  quantity?: number;
  price?: number;
  storeId?: number;
}

export interface UpdateInventoryItem {
  sku?: string;
  name?: string;
  description?: string;
  quantity?: number;
  price?: number;
}
