const mongoose = require('mongoose');

const geoFeatureSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['Feature'],
      required: true,
      default: 'Feature'
    },
    geometry: {
      type: {
        type: String,
        enum: ['Point', 'LineString', 'Polygon'],
        required: true
      },
      coordinates: {
        type: Array, // Allows flexible structure for all geometry types
        required: true
      }
    },
    properties: {
      name: {
        type: String,
        required: true
      },
      description: {
        type: String,
        default: ''
      },
      color: {
        type: String,
        default: '#000000' // Example property
      },
      category: {
        type: String
      },
      info: {
        type: String
      }
    }
  },
  {
    timestamps: true // Automatically adds createdAt and updatedAt
  }
);

module.exports = mongoose.model('GeoFeatureModel', geoFeatureSchema);
 