const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const connectDB = require('./config/mongodb');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Connect to MongoDB
connectDB();

// Auth routes (unprotected)
const authRoutes = require('./routes-mongodb/auth');
app.use('/api/auth', authRoutes);

// Protected routes (each router applies authMiddleware internally)
const customerRoutes = require('./routes-mongodb/customers');
const billRoutes = require('./routes-mongodb/bills');
const paymentRoutes = require('./routes-mongodb/payments');
const reportRoutes = require('./routes-mongodb/reports');
const dashboardRoutes = require('./routes-mongodb/dashboard');
const masterRoutes = require('./routes-mongodb/masters');

app.use('/api/customers', customerRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/masters', masterRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running', database: 'MongoDB' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📊 Using MongoDB database`);
});

module.exports = app;
