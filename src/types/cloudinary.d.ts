declare module "cloudinary" {
  export namespace v2 {
    interface UploadApiOptions {
      folder?: string;
      public_id?: string;
      overwrite?: boolean;
      resource_type?: "image" | "video" | "auto";
    }

    interface UploadApiResponse {
      secure_url: string;
    }

    function config(options: { cloudinary_url?: string }): void;

    const uploader: {
      upload(data: string, options: UploadApiOptions): Promise<UploadApiResponse>;
    };
  }

  export { v2 };
}
