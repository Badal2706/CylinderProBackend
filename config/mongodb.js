const mongoose = require('mongoose');

// MongoDB connection URI
// Default: local MongoDB instance
// You can change this to MongoDB Atlas or any other MongoDB instance
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    
    console.log('✅ MongoDB connected successfully');
    console.log(`📁 Database: ${mongoose.connection.name}`);
    console.log(`🌐 Host: ${mongoose.connection.host}`);
    
    // Initialize default data
    await initializeDefaultData();
    
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.log('\n📝 Make sure MongoDB is running on your system.');
    console.log('   Install: https://www.mongodb.com/docs/manual/installation/');
    console.log('   Or use MongoDB Atlas (cloud): https://www.mongodb.com/cloud/atlas');
    process.exit(1);
  }
};

// Initialize default data (gas types and cylinder sizes)
const initializeDefaultData = async () => {
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  
  try {
    // Add default gas types
    const gasTypes = [
      'Medical Oxygen',
      'Industrial Oxygen',
      'Nitrogen',
      'CO2',
      'Argon'
    ];
    
    for (const gasType of gasTypes) {
      await GasType.findOneAndUpdate(
        { gas_type_name: gasType },
        { gas_type_name: gasType, is_active: true },
        { upsert: true, new: true }
      );
    }
    
    // Add default cylinder sizes
    const sizes = ['1.5mm', '7mm', '10mm'];
    
    for (const size of sizes) {
      await CylinderSize.findOneAndUpdate(
        { size_label: size },
        { size_label: size, is_active: true },
        { upsert: true, new: true }
      );
    }
    
    console.log('✅ Default data initialized');
  } catch (error) {
    console.error('Error initializing default data:', error.message);
  }
};

// Handle connection events
mongoose.connection.on('connected', () => {
  console.log('📡 Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('Mongoose disconnected from MongoDB');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed through app termination');
  process.exit(0);
});

module.exports = connectDB;
