const mongoose = require('mongoose');

const adultGraveSchema = new mongoose.Schema({
  name: {
    firstName: String,
    lastName: String,
  },
  geometry: {
    type: {
      type: String,
      enum: ['Polygon'],
      required: true
    },
    coordinates: {
      type: [[[Number]]], // 3D array: [ [ [lng, lat], [lng, lat] ] ]
      required: true
    }
  }
});

module.exports = mongoose.model('AdultGrave', adultGraveSchema);
