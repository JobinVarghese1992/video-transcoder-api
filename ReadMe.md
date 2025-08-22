<!-- README.md -->
# Video Transcoding API (mp4 → mkv)

A Node.js (Express) REST API that uploads videos to **AWS S3** and asynchronously transcodes **MP4 → MKV (H.264 + AAC)** using `ffmpeg` on an EC2 instance. Metadata and variant records are stored in **DynamoDB** using a single-table design with GSI for listings.

## Features
- JWT auth with **roles** (admin/user) — simple in-memory users.
- **Direct-to-S3** uploads with **pre‑signed URLs** (single & multipart).
- DynamoDB records:
  - Parent `META` per video
  - Child `VARIANT#...` for originals and transcodes
- Async **ffmpeg** jobs with retry & concurrency controls.
- Filter listing by `transcode_status` (child rows), pagination.
- Bucket auto‑creation & **tagging** (`qut-username`, `purpose`).

## Quickstart

### Prereqs
- Node **18.19.1**
- AWS account & IAM credentials with access to S3 and DynamoDB
- EC2 Ubuntu instance with `ffmpeg` installed:
  ```bash
  sudo apt update && sudo apt install -y ffmpeg
