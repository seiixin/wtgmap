const GeoFeatureModel = require('../models/GeoFeatureModel');


exports.createGeoFeature = async (req, res) => {
  try {
    const newFeature = await GeoFeatureModel.create(req.body);
    res.status(201).json(newFeature);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
