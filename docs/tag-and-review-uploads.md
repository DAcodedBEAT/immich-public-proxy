# Tag and review visitor uploads

Immich workflows can act on each photo a visitor sends: tag it, copy it into a second album, or hold it back from the
gallery until you approve it. With an API key, the upload service can also record who sent each photo.

This guide assumes visitor uploads are already [set up](/visitor-uploads).

## Tag uploaded photos

Every uploaded file is stored with `ipp_upload_` at the start of its name. An Immich workflow can match the prefix
to tag uploads, or to copy them into a second album. The prefix is set by
[`upload.filenamePrefix`](/config/upload-service#filenameprefix); set it to `""` if you would rather keep the
visitor's filename unchanged. In Immich, open **Workflows** and create a workflow with:

1. Trigger: **Asset Upload**.
2. Filter: **Filter by filename**, match type `startsWith`, pattern `ipp_upload_`.
3. Action: **Add Tags** with a tag such as `Sent by visitors`, or **Add to Album(s)**.

### Why IPP marks the filename instead of tagging

IPP talks to Immich with the visitor's share key and nothing else. Immich lets a share key do exactly one write:
store a file into the share. Every tag endpoint needs an API key with tag permissions. By default the upload service
holds no API key, and giving one to a service that faces the public would let that service change your library. If
you accept that, see [Record who sent each photo](#record-who-sent-each-photo).

There are some other options under discussion in [GitHub discussion #302](https://github.com/alangrainger/immich-public-proxy/discussions/302). Feedback is welcome.

## Record who sent each photo

> [!WARNING]
> This is opt-in, and it gives up the upload service's main safety property: that it holds no API key. Leave it off
> unless you need to know who sent what.

Set [`IMMICH_API_KEY`](/config/upload-service#immich-api-key) on the upload service, not on IPP. The upload page
then asks each visitor for their name, remembered in their browser for next time, and an optional caption. For each
new photo the service:

- writes the description `<caption>` and `- Uploaded by <name>`, shown in the photo's info panel in Immich, and
- tags the photo `uploaded-by/<name>`, so clicking the tag lists everything that visitor sent, across all shares.

Visitors type whatever they like, so the name is a label, not proof of identity. Control characters, invisible and
text-direction characters are removed, the name is cut to 100 characters and the caption to 500. A `/` in a name
becomes `-`, so a name cannot add levels to your tag tree.

The service writes nothing for a file Immich already had, as that photo and its description are the owner's. The
name and caption also appear in the [notification](/config/upload-service#notifyurl), if you have one.

### Create the key

Uploads through a share belong to the Immich user who created the shared link, and Immich only lets an asset's owner
change its description or tags. So the key must belong to that user:

1. Sign in to Immich as the user who creates the shared links that accept uploads.
2. Under **Account Settings > API Keys**, create a key with only these permissions:
   - `asset.update`, for the description,
   - `tag.create` and `tag.asset`, for the tag.
3. Add it to the upload service's `environment` block, and restart it:

```yaml
    environment:
      IMMICH_URL: http://your-internal-immich-server:2283
      PUBLIC_BASE_URL: https://photos.example.com
      IMMICH_API_KEY: your-api-key
```

Leave out a permission to turn off that half: the first refusal logs one warning that names the missing permission,
and the service stops trying until it restarts. Uploads never fail because of the key.

### What the key can do

The service only ever uses the key to describe and tag a photo a visitor has just uploaded through a share that
allows uploads, after Immich has stored it. But anyone who takes the key from the container, or takes over the
service, can use those permissions on **every** photo of the user who owns it: rewrite every description, and
create and apply tags.

To keep that small:

- Give the key only `asset.update`, `tag.create` and `tag.asset`. Never `all`.
- Better still, use a dedicated Immich user for the shares that accept uploads, not your main account: create the
  albums and shared links as that user, share the albums with your own account, and give the key to that user. The
  key then reaches only that user's photos.
- Give that user a [storage quota](/visitor-uploads#set-a-storage-quota).
- Keep the container locked down as in the [compose example](/visitor-uploads#add-the-upload-service), and pass the
  key through a Docker secret or an `.env` file kept out of version control.

To turn it off, remove `IMMICH_API_KEY` and restart the upload service, then delete the key in Immich.

## Review uploads before they appear

Immich has no approval queue for uploads through a shared link, but a workflow can move each upload into your
**locked folder** the moment it arrives. IPP never shows a locked photo, so the upload leaves the gallery until you
decide to keep it. This is the staging step: visitors upload, you approve, the gallery updates.

The locked folder needs a PIN. Set one in your Immich account settings if you have not already. Then create a
workflow as in [Tag uploaded photos](#tag-uploaded-photos), with these actions:

1. Trigger: **Asset Upload**.
2. Filter: **Filter by filename**, match type `startsWith`, pattern `ipp_upload_`.
3. Action: **Move to locked folder**. Add a second action, **Add Tags**, if you want the approved uploads to stay
   easy to find afterwards.

To review, open the locked folder in Immich and enter your PIN. A photo's info panel lists the album it was sent
to under **Appears in**, since it is still a member while locked. Move the photos you want to keep out of the locked
folder: they return to the gallery on the next cache refresh. Delete the rest. Pair this with a
[notification](/visitor-uploads#get-a-notification-for-each-upload) so you know when there is something to review;
its message names the share, which is the only record of the destination for a share of individual photos, as those
have no album.

Two things to know:

- The upload is pulled back, not held back. The workflow runs a few seconds after the file is stored, and IPP
  caches a share's photo list for up to 2 minutes, so a visitor who has the gallery open can see the photo for a
  short while. Anyone who copied the photo's address in that window can keep opening it until you delete it.
- Keeping a photo relies on Immich leaving it in the album while it is locked, which it does for photos a workflow
  moves. If a future Immich version removes it from the album instead, add the approved photos back to the album
  by hand.
