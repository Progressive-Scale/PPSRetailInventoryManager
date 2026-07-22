import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { CreateInventoryItem, InventoryItem, UpdateInventoryItem } from './models';

@Injectable({ providedIn: 'root' })
export class InventoryService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/inventory';

  list(): Observable<InventoryItem[]> {
    return this.http.get<InventoryItem[]>(this.base);
  }

  create(dto: CreateInventoryItem): Observable<InventoryItem> {
    return this.http.post<InventoryItem>(this.base, dto);
  }

  update(id: string, dto: UpdateInventoryItem): Observable<InventoryItem> {
    return this.http.patch<InventoryItem>(`${this.base}/${id}`, dto);
  }

  remove(id: string): Observable<InventoryItem> {
    return this.http.delete<InventoryItem>(`${this.base}/${id}`);
  }
}
