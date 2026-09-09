package media

import (
	"bytes"
	"encoding/binary"
	"errors"
)

const (
	webpRIFFHeaderSize  = 12
	webpChunkHeaderSize = 8
	webpMaxRIFFSize     = uint64(1<<32 - 1)

	// VP8X retains only the two features needed by the normalized output:
	// alpha and animation. ICC, EXIF, XMP and reserved feature bits are not
	// part of the private media contract.
	webpVP8XAlphaFlag     byte = 0x10
	webpVP8XAnimationFlag byte = 0x02
)

var (
	errWebPPrivacyContainer = errors.New("normalized WebP container is malformed")
	webpStructuralChunks    = map[string]struct{}{
		"VP8X": {},
		"VP8 ": {},
		"VP8L": {},
		"ALPH": {},
		"ANIM": {},
		"ANMF": {},
	}
)

type webpContainerChunk struct {
	kind    string
	payload []byte
}

// stripWebPMetadata removes every non-structural top-level RIFF chunk from a
// freshly encoded WebP. The libvips saver is version-sensitive here: older
// releases can re-add metadata after the image-level cleanup performed by
// govips. Rebuilding the final container makes the privacy guarantee
// independent of that saver behavior while preserving encoded pixels.
func stripWebPMetadata(input []byte) ([]byte, error) {
	chunks, err := parseWebPContainer(input)
	if err != nil {
		return nil, err
	}

	outputSize := uint64(webpRIFFHeaderSize)
	for _, chunk := range chunks {
		if _, ok := webpStructuralChunks[chunk.kind]; !ok {
			continue
		}
		if chunk.kind == "VP8X" {
			if len(chunk.payload) != 10 || chunk.payload[1] != 0 || chunk.payload[2] != 0 || chunk.payload[3] != 0 {
				return nil, errWebPPrivacyContainer
			}
		}
		if uint64(len(chunk.payload)) > webpMaxRIFFSize {
			return nil, errWebPPrivacyContainer
		}
		chunkSize := uint64(webpChunkHeaderSize) + uint64(len(chunk.payload))
		if len(chunk.payload)%2 != 0 {
			chunkSize++
		}
		if chunkSize > webpMaxRIFFSize {
			return nil, errWebPPrivacyContainer
		}
		if outputSize > webpMaxRIFFSize-chunkSize {
			return nil, errWebPPrivacyContainer
		}
		outputSize += chunkSize
	}
	if outputSize < uint64(webpRIFFHeaderSize+webpChunkHeaderSize) || outputSize > uint64(^uint(0)>>1) {
		return nil, errWebPPrivacyContainer
	}

	output := make([]byte, int(outputSize))
	copy(output[:4], []byte("RIFF"))
	binary.LittleEndian.PutUint32(output[4:8], uint32(outputSize-8))
	copy(output[8:12], []byte("WEBP"))
	offset := webpRIFFHeaderSize
	for _, chunk := range chunks {
		if _, ok := webpStructuralChunks[chunk.kind]; !ok {
			continue
		}
		copy(output[offset:offset+4], chunk.kind)
		binary.LittleEndian.PutUint32(output[offset+4:offset+8], uint32(len(chunk.payload)))
		offset += webpChunkHeaderSize
		if chunk.kind == "VP8X" {
			// Do not retain metadata or unknown feature bits. Alpha and
			// animation describe the structural chunks kept below.
			output[offset] = chunk.payload[0] & (webpVP8XAlphaFlag | webpVP8XAnimationFlag)
			copy(output[offset+1:offset+len(chunk.payload)], chunk.payload[1:])
		} else {
			// ANMF payloads contain the freshly encoded frame header and its
			// VP8/VP8L/ALPH frame data. They are not user-supplied top-level
			// containers; the caller invokes this only after native re-encode.
			copy(output[offset:offset+len(chunk.payload)], chunk.payload)
		}
		offset += len(chunk.payload)
		if len(chunk.payload)%2 != 0 {
			// RIFF padding is not part of the chunk payload and is always
			// regenerated rather than copied from an untrusted container.
			offset++
		}
	}
	if offset != len(output) {
		return nil, errWebPPrivacyContainer
	}
	return output, nil
}

func parseWebPContainer(input []byte) ([]webpContainerChunk, error) {
	if len(input) < webpRIFFHeaderSize || !bytes.Equal(input[:4], []byte("RIFF")) || !bytes.Equal(input[8:12], []byte("WEBP")) {
		return nil, errWebPPrivacyContainer
	}
	riffSize := uint64(binary.LittleEndian.Uint32(input[4:8]))
	if riffSize < 4 || riffSize > uint64(len(input)-8) || riffSize != uint64(len(input)-8) {
		return nil, errWebPPrivacyContainer
	}
	end := len(input)
	chunks := make([]webpContainerChunk, 0, 4)
	for offset := webpRIFFHeaderSize; offset < end; {
		if offset > end-webpChunkHeaderSize {
			return nil, errWebPPrivacyContainer
		}
		kind := string(input[offset : offset+4])
		chunkSize := uint64(binary.LittleEndian.Uint32(input[offset+4 : offset+8]))
		offset += webpChunkHeaderSize
		if chunkSize > uint64(end-offset) {
			return nil, errWebPPrivacyContainer
		}
		payloadEnd := offset + int(chunkSize)
		chunks = append(chunks, webpContainerChunk{
			kind:    kind,
			payload: input[offset:payloadEnd],
		})
		offset = payloadEnd
		if chunkSize&1 != 0 {
			if offset >= end {
				return nil, errWebPPrivacyContainer
			}
			offset++
		}
	}
	if len(chunks) == 0 {
		return nil, errWebPPrivacyContainer
	}
	return chunks, nil
}
