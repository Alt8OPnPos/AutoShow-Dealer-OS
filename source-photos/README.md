# Source photos

Drop the **original** photo/video files here (not screenshots of your
phone's gallery or video player - the actual `.jpg`/`.heic`/`.mp4` files
straight off the camera roll). GitHub's mobile upload works fine for this:
repo -> this folder -> "Add file" -> "Upload files".

Once a file lands here, it can be retouched (deblur/denoise/upscale,
crop, straighten) and prepared for the site. Finished images still need
to be uploaded to the Cloudflare R2 bucket (`autoshow-vehicle-photos`)
before `worker.js` can serve them at `/photos/<key>` - there's currently
no automatic sync from this repo into R2, so that step stays manual via
the Cloudflare dashboard (R2 -> autoshow-vehicle-photos -> Upload) until
that gap gets closed.

Nothing in this folder is served directly by the Worker.
