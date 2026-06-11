import { v2 as cloudinary } from "cloudinary";

const cloudinaryUploadEnabled = Boolean(process.env.CLOUDINARY_URL);
if (cloudinaryUploadEnabled) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
}

export async function uploadAttachmentToCloudinary(dataUrl: string, publicId: string): Promise<string> {
  const folder = process.env.CLOUDINARY_FOLDER?.trim() || "nivashub/attachments";
  const upload = await cloudinary.uploader.upload(dataUrl, {
    folder,
    public_id: publicId,
    overwrite: false,
    resource_type: "auto",
  });
  return upload.secure_url;
}

export async function processAttachment(attachment: string, publicId: string) {
  if (!cloudinaryUploadEnabled || !attachment.startsWith("data:")) {
    return attachment;
  }
  return uploadAttachmentToCloudinary(attachment, publicId);
}
