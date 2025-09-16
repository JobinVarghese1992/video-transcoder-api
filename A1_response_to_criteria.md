Assignment 1 - REST API Project - Response to Criteria
================================================

Overview
------------------------------------------------

- **Name:** Jobin Varghese
- **Student number:** n11901152
- **Application name:** Video Transcoder
- **Two line description:** This is a REST based server app that provided apis to upload and transcode mp4 videos to mkv format.


Core criteria
------------------------------------------------

### Containerise the app

- **ECR Repository name:** n11901152/video-transcoder-api
- **Video timestamp:** 0:10
- **Relevant files:** 
    - /Dockerfile

### Deploy the container

- **EC2 instance ID:** i-063bae9d38eafe34f
- **Video timestamp:** 3:12 (On url you can see the instance id)

### User login

- **One line description:** Hard-coded username/password list.  Using JWTs for sessions.
- **Video timestamp:** 0:40
- **Relevant files:**
    - /src/routes/index.js
    - /src/middleware/auth.js

### REST API

- **One line description:** REST API with endpoints login, upload-url, complete-upload, transcode and HTTP methods (GET, POST, PUT, DELETE),
- **Video timestamp:** 0:35
- **Relevant files:**
    - /src/routes/index.js
    - /src/routes/videos.routes.js
    - /src/routes/videos.routes.js
    - /src/controllers/videos.controller.js

### Data types

- **One line description:** AWS DynamoDB for storing video metadata and S3 Buckets for storing video files
- **Video timestamp:** 1:40
- **Relevant files:**
    - /src/models/dynamo.js
    - /src/models/videos.repo.js
    - /src/controllers/videos.controller.js
    - /src/services/s3.service.js

#### First kind

- **One line description:** Dynamo DB for storing video meta data like filename, description, title and the path to the s3 bucket storage
- **Type:** Structured
- **Rationale:** Need to be able to query videos and the db and the s3 storage has to be in sync.
- **Video timestamp:** 1:40
- **Relevant files:**
    - /src/models/dynamo.js
    - /src/models/videos.repo.js
    - /src/controllers/videos.controller.js

#### Second kind

- **One line description:** S3 Buckeets to store video files and it is not feasible to store large files in db 
- **Type:** unstructured
- **Rationale:** Video files will be accessed by the server app by fetching the metadata including path of the video file from DynamoDB
- **Video timestamp:** 2:00
- **Relevant files:**
    - /src/models/videos.repo.js
    - /src/controllers/videos.controller.js
    - /src/services/s3.service.js

### CPU intensive task

 **One line description:** Transcodes the mp4 video file using ffmpeg and generated mkv file.
- **Video timestamp:** 4:20
- **Relevant files:**
    - src/controllers/videos.controller.js

### CPU load testing

 **One line description:** Send 3 transcode requests parallely to transcode 3 video files. Transcoding video files that are already uploaded.
- **Video timestamp:** 2:50
- **Relevant files:** 
    - transcode-all.js (Script to invoke multiple requests and load cpu)

Additional criteria
------------------------------------------------

### Extensive REST API features

- **One line description:** Implemented web app and supports versioning, pagination, filtering and sorting
- **Video timestamp:** 3:47
- **Relevant files:**
    - /src/controllers/videos.controller.js

### External API(s)

- **One line description:** Not attempted
- **Video timestamp:** 
- **Relevant files:**
    - 

### Additional types of data

- **One line description:** Uses JSON to store video related information in DynamoDB
- **Video timestamp:** 1:40
- **Relevant files:**
    - /src/controllers/videos.controller.js

### Custom processing

- **One line description:** transcodes uploaded MP4s from S3 using an in-house Node.js worker with FFmpeg. It re-uploads the resulting MKV files to S3, handling all job orchestration, including retries and metadata updates, in a custom pipeline.
- **Video timestamp:** 4:19
- **Relevant files:**
    - /src/controllers/videos.controller.js

### Infrastructure as code

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 

### Web client

- **One line description:** Web app that supports login, upload video, transcode video, watch videos, and also supporting pagination, sorting and filtering for videos
- **Video timestamp:** 3:49
- **Relevant files:**
    -   video-transcoder-webapp/

### Upon request

- **One line description:** Not attempted
- **Video timestamp:**
- **Relevant files:**
    - 