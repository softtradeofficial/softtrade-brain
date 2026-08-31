import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChatTurn, QueryResultPayload, SchemaPayload } from '../models/chat.models';
export interface SoftTradeERPContext {
  ClientRegId: number;
  CoSoftId: number;
  UserId: number;
  DivId: number;
  CoFinyear: number;
  CommonSalesOrder: boolean;
  UserName: string;
  RoleId: number;
  UserRole: string;
  RegNo: number;
  AppSoftCode: string;
  AppSoftType: string;
}
@Injectable({ providedIn: 'root' })
export class ChatService {
  private erpDataSubject = new BehaviorSubject<SoftTradeERPContext | null>(null);
  private baseUrl = environment.apiBaseUrl;
  private authToken = '';
  private customHeaders: Record<string, string> = {};
  erpData$ = this.erpDataSubject.asObservable();
  constructor(private http: HttpClient) {
    window.addEventListener('message',this.receiveMessage.bind(this)
    );
  }

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


   public receiveMessage(event: MessageEvent): void {
    console.log('Message received from ERP:', event);
    if (event.origin !== 'http://localhost:4200') {
      return;
    }
    const message = event.data;
    if (!message ||message.type !== 'SOFTTRADE_ERP_CONTEXT'
    ) {
      return;
    }
    console.log('ERP DATA:',message.data);
    this.erpDataSubject.next(message.data);
  }


  getERPData():
    SoftTradeERPContext | null {
    return this.erpDataSubject.value;
  }
}

