import { Component } from '@angular/core';

@Component({
  selector: 'app-erp-demo',
  templateUrl: './erp-demo.component.html',
  styleUrls: ['./erp-demo.component.css']
})
export class ErpDemoComponent {
  activeTab = 'ai-chat';
  selectedUserId = 0;
  userHeaders: Record<string, string> = {};

  get selectedRoleLabel(): string {
    if (Number(this.selectedUserId) === 0) return 'Super Administrator (All Access)';
    if (Number(this.selectedUserId) === 61) return 'AMITK - Office Executive (Divisions 45, 52, 53)';
    if (Number(this.selectedUserId) === 126) return 'RAMVILAS YADAV - Production Manager (Stock Only)';
    return 'STORE KEEPER (Stock Only - No Sales Bills Access)';
  }

  onUserChange(): void {
    const id = Number(this.selectedUserId);
    if (id === 0) {
      this.userHeaders = {};
    } else {
      this.userHeaders = {
        'X-User-Id': String(id),
      };
    }
  }
}
