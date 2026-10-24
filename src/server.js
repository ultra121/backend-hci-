import 'dotenv/config';
import app from './app.js';
import { connectDB } from './config/db.js';
import { seedAdminFromEnv } from './services/auth.service.js';

if (!process.env.JWT_SECRET) { console.error('JWT_SECRET missing in .env'); process.exit(1); }
await connectDB();
await seedAdminFromEnv();
const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`API running on :${port}`));
