const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');

const JWT_SECRET = process.env.JWT_SECRET || 'cylinderpro_jwt_2024';
const sign = (user) => jwt.sign(
  { id: user._id, name: user.name, email: user.email },
  JWT_SECRET,
  { expiresIn: '7d' }
);

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(400).json({ error: 'Email is already registered' });

    const user = new User({ name, email, password });
    await user.save();

    res.json({ token: sign(user), name: user.name, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/signin
router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid email or password' });

    res.json({ token: sign(user), name: user.name, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/clear-data  (protected — requires token + password confirmation)
router.post('/clear-data', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required to confirm' });

    const user = await User.findById(req.user.id);
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Incorrect password' });

    await Promise.all([
      Customer.deleteMany({ user_id: req.user.id }),
      Bill.deleteMany({ user_id: req.user.id }),
      Payment.deleteMany({ user_id: req.user.id })
    ]);

    res.json({ message: 'All data cleared successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
