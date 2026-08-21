import { Component } from '@angular/core';

@Component({
  selector: 'app-erp-demo',
  templateUrl: './erp-demo.component.html',
  styleUrls: ['./erp-demo.component.css']
})
export class ErpDemoComponent {
  activeTab = 'ai-chat';
  selectedUserId = 0;

  get selectedRoleLabel(): string {
    if (this.selectedUserId === 0) return 'Super Administrator (All Access)';
    if (this.selectedUserId === 61) return 'AMITK (Divisions 45, 52, 53)';
    return 'STORE KEEPER (Stock Only)';
  }

  get userHeaders(): Record<string, string> {
    if (this.selectedUserId === 0) {
      return {};
    }
    return {
      'X-User-Id': String(this.selectedUserId),
    };
  }

  onUserChange(): void {
    console.log('Switched simulated user to ID:', this.selectedUserId);
  }
}
