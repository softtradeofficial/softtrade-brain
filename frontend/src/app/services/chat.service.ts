import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChatTurn, QueryResultPayload, SchemaPayload } from '../models/chat.models';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private baseUrl = environment.apiBaseUrl;
  private authToken = '';
  private customHeaders: Record<string, string> = {};

  constructor(private http: HttpClient) {}

  public configure(options: { apiUrl?: string; authToken?: string; customHeaders?: Record<string, string> }): void {
    if (options.apiUrl) this.baseUrl = options.apiUrl.replace(/\/+$/, '');
    if (options.authToken !== undefined) this.authToken = options.authToken;
    if (options.customHeaders !== undefined) this.customHeaders = options.customHeaders;
  }

  private getHeaders(): HttpHeaders {
    let headers = new HttpHeaders(this.customHeaders);
    if (this.authToken) {
      headers = headers.set('Authorization', `Bearer ${this.authToken}`);
    }
    return headers;
  }

  ask(message: string, history: ChatTurn[]): Observable<QueryResultPayload> {
    return this.http.post<QueryResultPayload>(
      `${this.baseUrl}/chat`,
      { message, history },
      { headers: this.getHeaders() }
    );
  }

  schema(): Observable<SchemaPayload> {
    return this.http.get<SchemaPayload>(`${this.baseUrl}/schema`, { headers: this.getHeaders() });
  }

  health(): Observable<{ status: string; model: string; database: string }> {
    return this.http.get<{ status: string; model: string; database: string }>(
      `${this.baseUrl}/health`,
      { headers: this.getHeaders() }
    );
  }
}

