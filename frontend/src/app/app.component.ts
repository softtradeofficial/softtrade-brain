import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <div *ngIf="isEmbedded; else standaloneDemo" style="height: 100vh; width: 100vw; overflow: hidden;">
      <app-chat [placeholder]="'Ask about bills, party balances, stock, items...'"></app-chat>
    </div>
    <ng-template #standaloneDemo>
      <app-erp-demo></app-erp-demo>
    </ng-template>
  `,
})
export class AppComponent {
  isEmbedded = typeof window !== 'undefined' && window.self !== window.top;
}


