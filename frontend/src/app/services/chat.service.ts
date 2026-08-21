import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  ChatTurn,
  DatabaseListPayload,
  QueryResultPayload,
  SchemaPayload,
} from '../models/chat.models';

@Injectable({ providedIn: 'root' })
export class ChatService {
  constructor(private http: HttpClient) {}

  ask(message: string, history: ChatTurn[], database?: string): Observable<QueryResultPayload> {
    return this.http.post<QueryResultPayload>(`${environment.apiBaseUrl}/chat`, {
      message,
      history,
      database,
    });
  }

  databases(): Observable<DatabaseListPayload> {
    return this.http.get<DatabaseListPayload>(`${environment.apiBaseUrl}/databases`);
  }

  schema(database?: string): Observable<SchemaPayload> {
    const query = database ? `?database=${encodeURIComponent(database)}` : '';
    return this.http.get<SchemaPayload>(`${environment.apiBaseUrl}/schema${query}`);
  }

  health(): Observable<{ status: string; model: string; database: string }> {
    return this.http.get<{ status: string; model: string; database: string }>(
      `${environment.apiBaseUrl}/health`
    );
  }
}
