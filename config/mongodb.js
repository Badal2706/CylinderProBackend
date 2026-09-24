const mongoose = require('mongoose');
const logger = require('../logger');

// MongoDB connection URI — provided via the environment (see .env.example).
// Falls back to a local instance for non-containerized development only.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);

    logger.info(`MongoDB connected (db: ${mongoose.connection.name}, host: ${mongoose.connection.host})`);

    // Boot writes nothing. It used to upsert one global gas/size catalog on every start; since
    // 24 Sep 2026 each account owns its own catalog, written once at signup
    // (services/masters.service.seedDefaultCatalog).
  } catch (error) {
    logger.error('MongoDB connection error: ' + error.message);
    process.exit(1);
  }
};

// Connection lifecycle logging (shutdown is handled centrally in server.js).
mongoose.connection.on('error', (err) => {
  logger.error('Mongoose connection error: ' + err.message);
});
mongoose.connection.on('disconnected', () => {
  logger.warn('Mongoose disconnected from MongoDB');
});

module.exports = connectDB;
