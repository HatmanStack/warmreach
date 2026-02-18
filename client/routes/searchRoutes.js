import express from 'express';
import SearchController from '../src/domains/search/controllers/searchController.js';

const router = express.Router();
const searchController = new SearchController();

// Main search endpoint
router.post('/', async (req, res) => {
  await searchController.performSearch(req, res);
});

export default router;