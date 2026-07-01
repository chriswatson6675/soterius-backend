const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const { CSV_PATH } = require('../infra/utils/csvExporter');

// GET /api/gate/submissions.csv
// Protected by X-Admin-Token header matched against ADMIN_TOKEN env var.
// Streams the CSV file as a download.
router.get('/submissions.csv', (req, res) => {
  const token = req.headers['x-admin-token'];

  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!fs.existsSync(CSV_PATH)) {
    return res.status(404).json({ error: 'No submissions yet' });
  }

  res.download(CSV_PATH, 'soterius-submissions.csv');
});

module.exports = router;
