const express = require('express');
const router = express.Router();
const AdultGrave = require('../models/AdultGrave');

// GET all adult graves
router.get('/', async (req, res) => {
  try {
    const graves = await AdultGrave.find();
    res.json(graves);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch graves' });
  }
});

module.exports = router;
