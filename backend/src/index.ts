import express from 'express';
import cors from 'cors';
import { config } from './config';
import { chatRouter } from './routes/chat';
import { getCsinfoPool } from './csinfo';

const app = express();

app.use(
  cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: '256kb' }));

app.use('/api', chatRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(`[server] CORS origin: ${config.corsOrigin}`);
  console.log(`[server] CSInfo server: ${config.csinfo.server}/${config.csinfo.database}`);

  // Warm the CSInfo connection pool at startup so the first client lookup is instant.
  getCsinfoPool().catch((error) => {
    console.error('[server] could not connect to CSInfo database at startup:', error.message);
    console.error('[server] check your CSINFO_DB_* settings in backend/.env');
  });
});
