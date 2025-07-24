const express = require('express');
const router = express.Router();
const GeoFeature = require('../models/GeoFeatureModel');

// GET latest (last seen) geo feature
router.get('/last-seen', async (req, res) => {
  try {
    const latestFeature = await GeoFeature.findOne().sort({ updatedAt: -1 });
    
    if (!latestFeature) {
      return res.status(404).json({ message: 'No geo feature found' });
    }

    res.status(200).json(latestFeature);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

// GET all geo features
router.get('/', async (req, res) => {
  try {
    const features = await GeoFeature.find();
    res.json(features);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single geo feature by ID
router.get('/:id', async (req, res) => {
  try {
    const feature = await GeoFeature.findById(req.params.id);
    if (!feature) {
      return res.status(404).json({ message: 'Feature not found' });
    }
    res.json(feature);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new geo feature
router.post('/', async (req, res) => {
  try {
    const newFeature = new GeoFeature(req.body);
    await newFeature.save();
    res.status(201).json(newFeature);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update geo feature by ID
router.put('/:id', async (req, res) => {
  try {
    const updatedFeature = await GeoFeature.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!updatedFeature) {
      return res.status(404).json({ message: 'Feature not found' });
    }
    res.json(updatedFeature);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE geo feature by ID
router.delete('/:id', async (req, res) => {
  try {
    const deletedFeature = await GeoFeature.findByIdAndDelete(req.params.id);
    if (!deletedFeature) {
      return res.status(404).json({ message: 'Feature not found' });
    }
    res.json({ message: 'Feature deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
