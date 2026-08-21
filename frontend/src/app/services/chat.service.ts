import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChatTurn, QueryResultPayload, SchemaPayload } from '../models/chat.models';

@Injectable({ providedIn: 'root' })
export class ChatService {
  constructor(private http: HttpClient) {}

  ask(message: string, history: ChatTurn[]): Observable<QueryResultPayload> {
    return this.http.post<QueryResultPayload>(`${environment.apiBaseUrl}/chat`, { message, history });
  }

  schema(): Observable<SchemaPayload> {
    return this.http.get<SchemaPayload>(`${environment.apiBaseUrl}/schema`);
  }

  health(): Observable<{ status: string; model: string; database: string }> {
    return this.http.get<{ status: string; model: string; database: string }>(
      `${environment.apiBaseUrl}/health`
    );
  }
}
