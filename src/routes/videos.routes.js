import { Router } from 'express';
import {
  createUploadUrl,
  completeUpload,
  getVideo,
  listVideos,
  deleteVideo,
  startTranscode,
  // updateVideo,
} from '../controllers/videos.controller.js';

const router = Router();

// 1) Create pre-signed URL(s) for upload (single or multipart)
router.post('/videos/upload-url', createUploadUrl);

// 2) Complete upload (finalize multipart + write META + original VARIANT)
router.post('/videos/complete-upload', completeUpload);

// 3) List videos (metadata only, paginated via GSI1)
router.get('/videos', listVideos);

// 4) Get single video (META + variants)
router.get('/videos/:videoId', getVideo);

// 5) Delete video (and all variants)
router.delete('/videos/:videoId', deleteVideo);

// 6) Start transcoding to another format
router.post('/videos/:videoId/transcode', startTranscode);

// 7) Update video metadata (optional)
// router.put('/videos/:videoId', updateVideo);

export default router;
