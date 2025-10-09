export function authJob(req, res, next) {
    const got = req.headers['x-job-token'];
    if (!got || got !== process.env.API_JOB_STATUS_TOKEN) {
        return res.status(401).json({ error: { code: 'Unauthorized' } });
    }
    next();
}