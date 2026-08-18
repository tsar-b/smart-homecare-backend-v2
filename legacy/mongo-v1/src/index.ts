// src/index.ts

import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import kakaoRoutes from './routes/apiRoutes';
import connectDB from './config/db';
import authRoutes from './routes/apiRoutes';
import adminRoutes from './routes/adminRoutes';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', authRoutes);
app.use('/api', kakaoRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/', (_, res) => {
  res.send('Smart HomeCare Backend is running');
});

// Start server
app.listen(5000, '0.0.0.0', () => {
  console.log('✅ Server running at http://0.0.0.0:5000');
});
