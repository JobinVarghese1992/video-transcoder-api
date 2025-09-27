# Assignment 2 - Cloud Services Exercises - Response to Criteria

## Instructions

- Keep this file named A2_response_to_criteria.md, do not change the name
- Upload this file along with your code in the root directory of your project
- Upload this file in the current Markdown format (.md extension)
- Do not delete or rearrange sections. If you did not attempt a criterion, leave it blank
- Text inside [ ] like [eg. S3 ] are examples and should be removed

## Overview

- **Name:** Jobin Varghese
- **Student number:** n11901152
- **Partner name (if applicable):** John Jude Kuzhivelil
- **Application name:** Video Transcoder
- **Two line description:** We implemented a video transcoding app that converts an mp4 file to mkv.
- **EC2 instance name or ID:** i-063bae9d38eafe34f

---

### Core - First data persistence service

- **AWS service name:** [eg. S3] S3 Bucket
- **What data is being stored?:** [eg video files] Video Files
- **Why is this service suited to this data?:** [eg. large files are best suited to blob storage due to size restrictions on other services] Video files are usually very large in size and hence the use of s3.
- **Why is are the other services used not suitable for this data?:**DynamoDB and RDS are optimized for structured data and metadata queries, not large binary video files.
- **Bucket/instance/table name:**n11901152-videos
- **Video timestamp:**
- ## **Relevant files:**

### Core - Second data persistence service

- **AWS service name:** [eg. DynamoDB] DynamoDB
- **What data is being stored?:** Video metadata (videoId, title, description, createdBy, createdAt) and variant information (resolution, format, status, size).
- **Why is this service suited to this data?:** DynamoDB is fast, serverless, and scales well for high-frequency metadata queries with partition keys.
- **Why is are the other services used not suitable for this data?:** S3 doesn’t support efficient querying of metadata, and RDS requires manual schema management and scaling.
- **Bucket/instance/table name:** n11901152-video-table
- **Video timestamp:**
- ## **Relevant files:**

### Third data service

- **AWS service name:** [eg. RDS]
- **What data is being stored?:** [eg video metadata]
- **Why is this service suited to this data?:** [eg. ]
- **Why is are the other services used not suitable for this data?:** [eg. Advanced video search requires complex querries which are not available on S3 and inefficient on DynamoDB]
- **Bucket/instance/table name:**
- **Video timestamp:**
- ## **Relevant files:**

### S3 Pre-signed URLs

- **S3 Bucket names:** n11901152-videos
- **Video timestamp:**
- ## **Relevant files:**
  -video-transcoder-api/src/controllers/video.controller.js
  -video-transcoder-api/src/services/s3.services.js

### In-memory cache

- **ElastiCache instance name:**
- **What data is being cached?:** [eg. Thumbnails from YouTube videos obatined from external API]
- **Why is this data likely to be accessed frequently?:** [ eg. Thumbnails from popular YouTube videos are likely to be shown to multiple users ]
- **Video timestamp:**
- ## **Relevant files:**

### Core - Statelessness

- **What data is stored within your application that is not stored in cloud data services?:** [eg. intermediate video files that have been transcoded but not stabilised] Temporary video files during transcoding (downloaded originals and generated MKV outputs) are stored in the container’s /tmp directory. These are working files that exist only while ffmpeg is running.
- **Why is this data not considered persistent state?:** [eg. intermediate files can be recreated from source if they are lost] These intermediate files are not required after transcoding completes. The originals and transcoded variants are always uploaded and persisted in S3, and metadata is persisted in DynamoDB. If the container crashes or is restarted, the temporary files can be safely discarded and recreated from S3, so they are not considered persistent state.
- **How does your application ensure data consistency if the app suddenly stops?:** [eg. journal used to record data transactions before they are done. A separate task scans the journal and corrects problems on startup and once every 5 minutes afterwards. ] Because persistent storage is delegated to S3 (for video binaries) and DynamoDB (for metadata), the system can recover from failures. If the app stops mid-transcode, the original video still exists in S3, and the transcoding process can simply be retried. DynamoDB ensures metadata consistency, and the client can poll for video/variant status until it reaches completed. No critical state is lost in the application layer itself.
- ## **Relevant files:**
  -video-transcoder-api/src/services/ffmpeg.service.js

### Graceful handling of persistent connections

- **Type of persistent connection and use:** [eg. server-side-events for progress reporting]
- **Method for handling lost connections:** [eg. client responds to lost connection by reconnecting and indicating loss of connection to user until connection is re-established ]
- ## **Relevant files:**

### Core - Authentication with Cognito

- **User pool name:** n11901152-Assessment2UP
- **How are authentication tokens handled by the client?:** JWT tokens stored client-side, sent as Authorization: Bearer token in API requests.
- **Video timestamp:**
- ## **Relevant files:**
  -video-transcoder-api/src/controllers/auth.controller.js
  -video-transcoder-api/src/services/auth.service.js

### Cognito multi-factor authentication

- **What factors are used for authentication:** [eg. password, SMS code] password, Email OTP
- **Video timestamp:**
- ## **Relevant files:**
  -video-transcoder-api/src/controllers/auth.controller.js
  -video-transcoder-api/src/services/auth.service.js

### Cognito federated identities

- **Identity providers used:**
- **Video timestamp:**
- ## **Relevant files:**

### Cognito groups

- **How are groups used to set permissions?:** [eg. 'admin' users can delete and ban other users] admin user group can view and delete all videos uploaded
- **Video timestamp:**
- ## **Relevant files:**
  -video-transcoder-api/src/middleware/auth.js
  -video-transcoder-api/src/controllers/auth.controller.js
  -video-transcoder-api/src/services/auth.service.js

### Core - DNS with Route53

- **Subdomain**: [eg. myawesomeapp.cab432.com] a2-n11870192.cab432.com
- **Video timestamp:**

### Parameter store

- **Parameter names:** [eg. n1234567/base_url] n11870192/VIDEO_BUCKET, n11870192/DDB_TABLE, n11870192/PRESIGNED_TTL_SECONDS, n11870192/n11870192/MAX_CONCURRENT_JOBS, n11870192/MAX_OBJECT_SIZE_BYTES, n11870192/MULTIPART_PART_SIZE_MB, n11870192/MULTIPART_THRESHOLD_MB, n11870192/TEMP_DIR, n11870192/MAX_OBJECT_SIZE_BYTES
- **Video timestamp:**
- ## **Relevant files:**
  -video-transcoder-api/src/services/parameter.service.js

### Secrets manager

- **Secrets names:** [eg. n1234567-youtube-api-key] n11870192/COGNITO_CLIENT_ID, n11870192/COGNITO_CLIENT_SECRET, n11870192/COGNITO_USERPOOL_ID
- **Video timestamp:**
- ## **Relevant files:**
  -video-transcoder-api/src/services/secrets.service.js

### Infrastructure as code

- **Technology used:**
- **Services deployed:**
- **Video timestamp:**
- ## **Relevant files:**

### Other (with prior approval only)

- **Description:**
- **Video timestamp:**
- ## **Relevant files:**

### Other (with prior permission only)

- **Description:**
- **Video timestamp:**
- ## **Relevant files:**
