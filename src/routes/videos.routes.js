// src/routes/videos.routes.js
import { Router } from 'express';
import * as VideosController from '../controllers/videos.controller.js';
import { validate } from '../middleware/validate.js';
import {
  CreateUploadUrlSchema,
  CompleteUploadSchema,
  ListVideosSchema,
  UpdateVideoSchema,
  StartTranscodeSchema,
  ReplaceUploadUrlSchema,
  CompleteReplaceSchema
} from '../controllers/videos.controller.js';

export const videosRouter = Router();

// Upload presign (single or multipart)
videosRouter.post('/upload-url', validate(CreateUploadUrlSchema), VideosController.createUploadUrl);

// Complete upload (single or multipart)
videosRouter.post('/complete-upload', validate(CompleteUploadSchema), VideosController.completeUpload);

// List videos
videosRouter.get('/', validate(ListVideosSchema, 'query'), VideosController.listVideos);

// Get one
videosRouter.get('/:videoId', VideosController.getVideo);

// Update metadata
videosRouter.put('/:videoId', validate(UpdateVideoSchema), VideosController.updateVideo);

// Start transcoding
videosRouter.post('/:videoId/transcode', validate(StartTranscodeSchema), VideosController.startTranscoding);

// Delete video
videosRouter.delete('/:videoId', VideosController.deleteVideo);

// Replace original: request presigned URL(s)
videosRouter.put('/:videoId/file', validate(ReplaceUploadUrlSchema), VideosController.replaceOriginalPresign);

// Complete replace
videosRouter.post('/:videoId/file/complete', validate(CompleteReplaceSchema), VideosController.completeReplaceOriginal);
