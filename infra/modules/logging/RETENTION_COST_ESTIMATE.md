# Log Retention Cost Estimate

Illustrative `us-east-1` storage-only comparison for 100 GB of uncompressed logs ingested monthly and retained for one year. This is a planning estimate, not a Terraform plan or AWS bill; replace the assumed rates and compression ratio with measured account data before approval.

Assumptions:

- CloudWatch Logs storage: `$0.03/GB-month`.
- S3 Standard storage: `$0.023/GB-month`.
- S3 Glacier Flexible Retrieval: `$0.0036/GB-month`.
- CloudWatch exports average 30% of their uncompressed size after gzip.
- The baseline has no expiry and has accumulated 12 months of data; the new policy keeps 30 days in CloudWatch, a second 30-day copy in S3 Standard, and the remaining 11 months in Glacier.
- Excludes ingestion, requests, Lambda/EventBridge, retrieval, early deletion, and data transfer charges.

| Policy at month 12 | Stored data | Estimated monthly storage |
| --- | ---: | ---: |
| No retention (all 12 months in CloudWatch) | 1,200 GB hot | `$36.00` |
| 30 days CloudWatch + 30 days S3 Standard + 11 months Glacier | 100 GB hot + 30 GB standard + 330 GB archive | `$4.88` |

Calculation: `(100 x $0.03) + (30 x $0.023) + (330 x $0.0036) = $4.878/month`, approximately 86% less storage cost than the 12-month hot-storage baseline. Actual savings depend on ingestion volume, compression, AWS region, and retrieval frequency. Use the [AWS Pricing Calculator](https://calculator.aws/) with CloudWatch Logs, S3 Standard, and S3 Glacier Flexible Retrieval before deployment.