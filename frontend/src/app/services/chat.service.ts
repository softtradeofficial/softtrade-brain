import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChatTurn, QueryResultPayload, SchemaPayload } from '../models/chat.models';

export interface SoftTradeERPContext {
  ClientRegId: number;
  CoSoftId?: number;
  UserId?: number;
  DivId?: number;
  CoFinyear?: number;
  CommonSalesOrder?: boolean;
  UserName?: string;
  RoleId?: number;
  UserRole?: string;
  RegNo?: number;
  AppSoftCode?: string;
  AppSoftType?: string;
}

export interface HealthPayload {
  status: string;
  model: string;
  database: string;
  clientName?: string;
  clientRegId?: number;
  server?: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private erpDataSubject = new BehaviorSubject<SoftTradeERPContext | null>(null);
  private baseUrl = environment.apiBaseUrl;
  private authToken = '';
  private customHeaders: Record<string, string> = {};

  erpData$ = this.erpDataSubject.asObservable();

  constructor(private http: HttpClient) {
    window.addEventListener('message', this.receiveMessage.bind(this));
    this.initFromQueryParams();

    // Notify parent ERP iframe host (MandiAngular) that SoftTrade Brain is ready to receive context
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      try {
        window.parent.postMessage({ type: 'SOFTTRADE_BRAIN_READY' }, '*');
      } catch {
        // Ignore cross-origin frame errors
      }
    }
  }

  private initFromQueryParams(): void {
    if (typeof window === 'undefined' || !window.location?.search) return;
    const params = new URLSearchParams(window.location.search);
    const clientRegId = Number(params.get('ClientRegId') || params.get('clientRegId') || '0');
    const regNo = Number(params.get('RegNo') || params.get('regNo') || '0');
    if (clientRegId > 0 || regNo !== 0) {
      const ctx: SoftTradeERPContext = {
        ClientRegId: clientRegId,
        CoSoftId: Number(params.get('CoSoftId') || params.get('coSoftId') || '0'),
        UserId: Number(params.get('UserId') || params.get('userId') || '0'),
        DivId: Number(params.get('DivId') || params.get('divId') || '0'),
        CoFinyear: Number(params.get('CoFinyear') || params.get('coFinyear') || '0'),
        CommonSalesOrder: params.get('CommonSalesOrder') === 'true' || params.get('CommonSalesOrder') === '1',
        UserName: params.get('UserName') || params.get('userName') || '',
        RoleId: Number(params.get('RoleId') || params.get('roleId') || '0'),
        UserRole: params.get('UserRole') || params.get('userRole') || '',
        RegNo: regNo,
        AppSoftCode: params.get('AppSoftCode') || '',
        AppSoftType: params.get('AppSoftType') || '',
      };
      this.erpDataSubject.next(ctx);
    }
  }

  public configure(options: { apiUrl?: string; authToken?: string; customHeaders?: Record<string, string> }): void {
    if (options.apiUrl) this.baseUrl = options.apiUrl.replace(/\/+$/, '');
    if (options.authToken !== undefined) this.authToken = options.authToken;
    if (options.customHeaders !== undefined) this.customHeaders = options.customHeaders;
  }

  public setERPData(data: SoftTradeERPContext | null): void {
    this.erpDataSubject.next(data);
  }

  private getHeaders(): HttpHeaders {
    let headers = new HttpHeaders(this.customHeaders);
    if (this.authToken) {
      headers = headers.set('Authorization', `Bearer ${this.authToken}`);
    }

    const erp = this.erpDataSubject.value;
    if (erp) {
      if (erp.ClientRegId !== undefined && erp.ClientRegId !== null) {
        headers = headers.set('X-Client-Reg-Id', String(erp.ClientRegId));
      }
      if (erp.RegNo !== undefined && erp.RegNo !== null) {
        headers = headers.set('X-Reg-No', String(erp.RegNo));
      }
      if (erp.UserId !== undefined && erp.UserId !== null && !headers.has('X-User-Id')) {
        headers = headers.set('X-User-Id', String(erp.UserId));
      }
      if (erp.CoSoftId !== undefined && erp.CoSoftId !== null) {
        headers = headers.set('X-CoSoft-Id', String(erp.CoSoftId));
      }
      if (erp.DivId !== undefined && erp.DivId !== null) {
        headers = headers.set('X-Div-Id', String(erp.DivId));
      }
      if (erp.CoFinyear !== undefined && erp.CoFinyear !== null) {
        headers = headers.set('X-CoFinyear', String(erp.CoFinyear));
      }
      if (erp.CommonSalesOrder !== undefined && erp.CommonSalesOrder !== null) {
        headers = headers.set('X-Common-Sales-Order', String(!!erp.CommonSalesOrder));
      }
      if (erp.RoleId !== undefined && erp.RoleId !== null) {
        headers = headers.set('X-Role-Id', String(erp.RoleId));
      }
      if (erp.UserRole) {
        headers = headers.set('X-User-Role', String(erp.UserRole));
      }
      if (erp.UserName) {
        headers = headers.set('X-User-Name', String(erp.UserName));
      }
      if (erp.AppSoftCode) {
        headers = headers.set('X-App-Soft-Code', String(erp.AppSoftCode));
      }
      if (erp.AppSoftType) {
        headers = headers.set('X-App-Soft-Type', String(erp.AppSoftType));
      }
    }

    return headers;
  }

  ask(message: string, history: ChatTurn[]): Observable<QueryResultPayload> {
    const erp = this.erpDataSubject.value;
    return this.http.post<QueryResultPayload>(
      `${this.baseUrl}/chat`,
      {
        message,
        history,
        clientRegId: erp?.ClientRegId,
        regNo: erp?.RegNo,
        userId: erp?.UserId,
        erpContext: erp || undefined,
      },
      { headers: this.getHeaders() }
    );
  }

  schema(refresh = false): Observable<SchemaPayload> {
    const query = refresh ? '?refresh=true' : '';
    return this.http.get<SchemaPayload>(`${this.baseUrl}/schema${query}`, { headers: this.getHeaders() });
  }

  health(): Observable<HealthPayload> {
    return this.http.get<HealthPayload>(`${this.baseUrl}/health`, { headers: this.getHeaders() });
  }

  public receiveMessage(event: MessageEvent): void {
    const message = event?.data;
    if (!message || message.type !== 'SOFTTRADE_ERP_CONTEXT' || !message.data) {
      return;
    }
    console.log('Message received from ERP:', event.origin, message.data);
    this.erpDataSubject.next(message.data as SoftTradeERPContext);
  }

  getERPData(): SoftTradeERPContext | null {
    return this.erpDataSubject.value;
  }
}
