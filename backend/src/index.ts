import express from 'express';
import cors from 'cors';
import { config } from './config';
import { chatRouter } from './routes/chat';
import { getSchema } from './schema';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', model: config.openai.model, database: config.db.database });
});

app.use('/api', chatRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(`[server] CORS origin: ${config.corsOrigin}`);

  // Warm the schema cache so the first question is not slowed down by introspection.
  getSchema().catch((error) => {
    console.error('[server] could not load the database schema at startup:', error.message);
    console.error('[server] check your DB_* settings in backend/.env');
  });
});
