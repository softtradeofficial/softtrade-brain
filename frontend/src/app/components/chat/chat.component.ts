import { AfterViewChecked, Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core';
import { ChatService } from '../../services/chat.service';
import { ChatMessage, ChatTurn, SchemaTable } from '../../models/chat.models';

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
})
export class ChatComponent implements OnInit, AfterViewChecked {
  @ViewChild('scrollPane') private scrollPane?: ElementRef<HTMLElement>;

  @Input() apiUrl?: string;
  @Input() authToken?: string;
  @Input() customHeaders?: Record<string, string>;
  @Input() placeholder = 'Ask a question in plain English, e.g. "How many bills were created today?"';
  @Input() suggestions: string[] = [
    'How many companies are there?',
    'How many bills were created today?',
    'What is the total billed amount today?',
    'Show the 10 most recent bills',
    'Which company has the most bills this month?',
  ];

  messages: ChatMessage[] = [];
  draft = '';
  loading = false;
  connectionError = '';

  database = '';
  model = '';
  tables: SchemaTable[] = [];
  showSchema = false;
  schemaFilter = '';

  private nextId = 1;
  private shouldScroll = false;

  constructor(private chat: ChatService) {}

  ngOnInit(): void {
    if (this.apiUrl || this.authToken || this.customHeaders) {
      this.chat.configure({
        apiUrl: this.apiUrl,
        authToken: this.authToken,
        customHeaders: this.customHeaders,
      });
    }

    this.chat.health().subscribe({
      next: (info) => {
        this.database = info.database;
        this.model = info.model;
      },
      error: () => {
        this.connectionError =
          'Cannot reach the API. Check connection or start the backend service.';
      },
    });

    this.chat.schema().subscribe({
      next: (payload) => {
        this.tables = payload.tables;
        this.database = payload.database;
      },
      error: () => {
        /* The health check already reports connection problems. */
      },
    });
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll && this.scrollPane) {
      this.scrollPane.nativeElement.scrollTop = this.scrollPane.nativeElement.scrollHeight;
      this.shouldScroll = false;
    }
  }

  get filteredTables(): SchemaTable[] {
    const filter = this.schemaFilter.trim().toLowerCase();
    if (!filter) return this.tables;
    return this.tables.filter(
      (table) =>
        table.name.toLowerCase().includes(filter) ||
        table.columns.some((column) => column.toLowerCase().includes(filter))
    );
  }

  useSuggestion(text: string): void {
    this.draft = text;
    this.send();
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    const question = this.draft.trim();
    if (!question || this.loading) return;

    this.connectionError = '';
    this.draft = '';
    this.loading = true;
    this.shouldScroll = true;

    const history = this.buildHistory();

    this.messages.push({ id: this.nextId++, role: 'user', text: question });

    const placeholder: ChatMessage = {
      id: this.nextId++,
      role: 'assistant',
      text: '',
      pending: true,
    };
    this.messages.push(placeholder);

    this.chat.ask(question, history).subscribe({
      next: (payload) => {
        Object.assign(placeholder, {
          pending: false,
          text: payload.answer,
          sql: payload.sql,
          intent: payload.intent,
          columns: payload.columns ?? [],
          rows: payload.rows ?? [],
          rowCount: payload.rowCount ?? 0,
          truncated: payload.truncated ?? false,
          elapsedMs: payload.elapsedMs ?? 0,
          failed: !!payload.error,
          showSql: false,
        });
        this.loading = false;
        this.shouldScroll = true;
      },
      error: (error) => {
        const detail =
          error?.error?.error ?? error?.message ?? 'The request failed. Is the API running?';
        Object.assign(placeholder, { pending: false, failed: true, text: detail });
        this.loading = false;
        this.shouldScroll = true;
      },
    });
  }

  toggleSql(message: ChatMessage): void {
    message.showSql = !message.showSql;
  }

  copySql(message: ChatMessage): void {
    if (message.sql) {
      void navigator.clipboard.writeText(message.sql);
    }
  }

  clear(): void {
    this.messages = [];
  }

  trackById(_index: number, message: ChatMessage): number {
    return message.id;
  }

  trackByName(_index: number, table: SchemaTable): string {
    return table.name;
  }

  /** Only completed turns are sent back, so the model can resolve follow-up questions. */
  private buildHistory(): ChatTurn[] {
    return this.messages
      .filter((message) => !message.pending && !message.failed && message.text)
      .slice(-6)
      .map((message) => ({ role: message.role, content: message.text }));
  }
}
