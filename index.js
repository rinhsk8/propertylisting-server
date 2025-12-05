import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import propertyRoutes from './routes/property.routes.js';
import apartmentRoutes from './routes/apartment.routes.js';
import landRoutes from './routes/land.routes.js';
import locationRoutes from './routes/location.routes.js';
import authRoutes from './routes/auth.route.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({
  origin: ['http://localhost:3000'],
  credentials: true
}));

// Routes
app.use('/api/properties', propertyRoutes);
app.use('/api/apartment', apartmentRoutes);
app.use('/api/land', landRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/auth', authRoutes);
// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to AreProperty API' });
});

// Start server
app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});