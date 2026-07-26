import { Request, Response } from 'express';
import { UploadApiResponse } from 'cloudinary';
import { User } from '../models/User.model';
import { cloudinary } from '../config/cloudinary';
import { sendSuccess, sendError } from '../utils/response';

// New: profile picture upload. The file arrives in memory as req.file.buffer
// (see upload.middleware.ts — multer.memoryStorage()), so we stream it
// straight to Cloudinary instead of writing it to disk first.
export const uploadProfileImage = async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    sendError(res, 'No image file provided.', 400);
    return;
  }

  const userId = req.user!._id.toString();

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        // Fixed public_id per user + overwrite: true means every re-upload
        // replaces the same Cloudinary asset — no old images pile up in
        // storage, and we never need to track/delete a separate public_id.
        public_id: `profile-images/${userId}`,
        folder: 'mailzeon',
        overwrite: true,
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
      },
      (error, uploadResult) => {
        if (error || !uploadResult) return reject(error ?? new Error('Image upload failed.'));
        resolve(uploadResult);
      }
    );
    stream.end(req.file!.buffer);
  });

  const user = await User.findByIdAndUpdate(
    userId,
    { profileImage: result.secure_url },
    { new: true }
  );

  sendSuccess(res, 'Profile image updated.', user);
};
