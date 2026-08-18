import dotenv from 'dotenv';
import { createHttpServer } from './core/http.js';

dotenv.config();

const app = createHttpServer();
const port = Number(process.env.PORT ?? 5000);

app.listen(port, '0.0.0.0', () => {
  console.log(`Backend running on :${port}`);
});
