import { Component, OnInit } from '@angular/core';
import { ChatService } from '../services/chat.service';

@Component({
  selector: 'app-erp-demo',
  templateUrl: './erp-demo.component.html',
  styleUrls: ['./erp-demo.component.css']
})
export class ErpDemoComponent implements OnInit {
  activeTab = 'ai-chat';
  selectedClientRegId = 49;
  selectedUserId = 0;
  userHeaders: Record<string, string> = {};

  clients = [
    { regId: 49, label: 'Rara Enterprises (RegId: 49)' },
    { regId: 672, label: 'Shree Tadkeshwar (RegId: 672)' },
    { regId: 68640, label: 'Raghu Enterprises (RegId: 68640)' },
    { regId: 69685, label: 'Mahesh Agarwal Bandikui (RegId: 69685)' },
    { regId: 68587, label: 'Bajargan (RegId: 68587)' },
    { regId: 69684, label: 'RDP Oil Industries LLP (RegId: 69684)' },
  ];

  constructor(private chat: ChatService) {}

  ngOnInit(): void {
    const existing = this.chat.getERPData();
    if (existing?.ClientRegId) {
      this.selectedClientRegId = existing.ClientRegId;
      this.selectedUserId = existing.UserId ?? 0;
    }
    this.syncHeaders();
  }

  get selectedRoleLabel(): string {
   // if (Number(this.selectedUserId) === 0 || Number(this.selectedUserId) === -1) {
      return 'Super Administrator (All Access)';
    //}
   // if (Number(this.selectedUserId) === 61) return 'AMITK - Office Executive (Divisions 45, 52, 53)';
    //if (Number(this.selectedUserId) === 126) return 'RAMVILAS YADAV - Production Manager (Stock Only)';
    return 'STORE KEEPER (Stock Only - No Sales Bills Access)';
  }

  onClientChange(): void {
    this.syncHeaders();
  }

  onUserChange(): void {
    this.syncHeaders();
  }

  private syncHeaders(): void {
    const headers: Record<string, string> = {
      'X-Client-Reg-Id': String(this.selectedClientRegId),
    };
    const id = Number(this.selectedUserId);
    if (id !== 0) {
      headers['X-User-Id'] = String(id);
    }
    this.userHeaders = headers;
  }
}

