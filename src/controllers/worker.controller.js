import { updateVariant } from '../models/videos.repo.js';

export async function jobStatus(req, res, next) {
    try {
        const { qutUsername, videoId, variantId, status, url = '', size = 0 } = req.body || {};

        if (!qutUsername || !videoId || !variantId || !status) {
            return res.status(400).json({ error: { code: 'BadRequest', message: 'Missing fields' } });
        }

        const patch =
            status === 'completed'
                ? { transcode_status: 'completed', url, size }
                : { transcode_status: 'failed' };

        await updateVariant({ qutUsername, videoId, variantId, patch });

        res.json({ ok: true, message: `Job ${status}` });
    } catch (err) {
        next(err);
    }
}