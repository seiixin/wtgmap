const express = require('express');
const router = express.Router();
const { getAllGraves, searchGraves } = require('../controllers/graveController');

router.get('/search', searchGraves);      // ✅ GET /api/graves/search?firstName=marites&lastName=galang

module.exports = router;
