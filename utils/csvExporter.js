const { createObjectCsvWriter } = require('csv-writer');
const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

// NOTE: Railway has an ephemeral filesystem — this file is lost on redeploy.
// Phase 2: replace with S3/R2 object storage or a database.
const CSV_PATH = path.join(__dirname, '..', 'submissions.csv');

const HEADERS = [
  { id: 'submissionId',  title: 'Submission ID'  },
  { id: 'timestamp',     title: 'Timestamp'       },
  { id: 'domain',        title: 'Domain'          },
  { id: 'email',         title: 'Email'           },
  { id: 'name',          title: 'Name'            },
  { id: 'firmName',      title: 'Firm Name'       },
  { id: 'mainConcern',   title: 'Main Concern'    },
  { id: 'itManagement',  title: 'IT Management'   },
  { id: 'dataIncidents', title: 'Data Incidents'  },
  { id: 'confidence',    title: 'Confidence (1-5)'},
  { id: 'scanScore',     title: 'Scan Score'      },
  { id: 'ssl',           title: 'SSL'             },
  { id: 'headers',       title: 'Headers'         },
  { id: 'dns',           title: 'DNS/DMARC'       },
  { id: 'subdomains',    title: 'Subdomains'      },
  { id: 'tech',          title: 'Tech'            },
  { id: 'gdpr',          title: 'GDPR'            },
];

async function appendSubmissionToCSV(data) {
  // Only write headers when the file doesn't yet exist (or is empty).
  const fileExists = fs.existsSync(CSV_PATH) && fs.statSync(CSV_PATH).size > 0;

  const writer = createObjectCsvWriter({
    path:   CSV_PATH,
    header: HEADERS,
    append: fileExists,
  });

  await writer.writeRecords([data]);
  logger.info(`[CSV] Submission ${data.submissionId} written to ${CSV_PATH}`);
  return { success: true, submissionId: data.submissionId };
}

module.exports = { appendSubmissionToCSV, CSV_PATH };
