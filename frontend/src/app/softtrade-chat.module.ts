import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

import { ChatComponent } from './components/chat/chat.component';
import { ResultTableComponent } from './components/result-table/result-table.component';
import { ChatService } from './services/chat.service';

@NgModule({
  declarations: [ChatComponent, ResultTableComponent],
  imports: [CommonModule, HttpClientModule, FormsModule],
  exports: [ChatComponent, ResultTableComponent],
  providers: [ChatService],
})
export class SoftTradeChatModule {}
