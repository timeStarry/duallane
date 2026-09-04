package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

type imageHeader struct {
	format           string
	width            uint64
	height           uint64
	frameWidth       uint64
	frameHeight      uint64
	frameCount       int
	durationMS       int64
	totalFramePixels uint64
	bmp              *bmpHeader
}

type bmpHeader struct {
	width         int
	height        int
	topDown       bool
	pixelOffset   uint64
	rowStride     uint64
	bytesPerPixel int
}

var errMalformedImage = errors.New("image header is malformed")

func inspectImage(input []byte) (imageHeader, error) {
	switch {
	case len(input) >= 3 && bytes.Equal(input[:3], []byte{0xff, 0xd8, 0xff}):
		width, height, err := inspectJPEG(input)
		if err != nil {
			return imageHeader{}, err
		}
		return staticImageHeader("jpeg", width, height), nil
	case len(input) >= 8 && bytes.Equal(input[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		width, height, err := inspectPNG(input)
		if err != nil {
			return imageHeader{}, err
		}
		return staticImageHeader("png", width, height), nil
	case len(input) >= 6 && (bytes.Equal(input[:6], []byte("GIF87a")) || bytes.Equal(input[:6], []byte("GIF89a"))):
		return inspectGIF(input)
	case len(input) >= 12 && bytes.Equal(input[:4], []byte("RIFF")) && bytes.Equal(input[8:12], []byte("WEBP")):
		return inspectWebP(input)
	case len(input) >= 2 && bytes.Equal(input[:2], []byte("BM")):
		return inspectBMP(input)
	default:
		return imageHeader{}, errMalformedImage
	}
}

func inspectJPEG(input []byte) (uint64, uint64, error) {
	if len(input) < 4 || input[0] != 0xff || input[1] != 0xd8 {
		return 0, 0, errMalformedImage
	}
	for offset := 2; offset < len(input); {
		if input[offset] != 0xff {
			offset++
			continue
		}
		for offset < len(input) && input[offset] == 0xff {
			offset++
		}
		if offset >= len(input) {
			return 0, 0, errMalformedImage
		}
		marker := input[offset]
		offset++
		if marker == 0xd9 || marker == 0xda {
			break
		}
		if marker == 0x01 || marker >= 0xd0 && marker <= 0xd7 {
			continue
		}
		if offset+2 > len(input) {
			return 0, 0, errMalformedImage
		}
		segmentLength := int(binary.BigEndian.Uint16(input[offset : offset+2]))
		if segmentLength < 2 || segmentLength > len(input)-offset {
			return 0, 0, errMalformedImage
		}
		if isJPEGStartOfFrame(marker) {
			if segmentLength < 7 {
				return 0, 0, errMalformedImage
			}
			height := uint64(binary.BigEndian.Uint16(input[offset+3 : offset+5]))
			width := uint64(binary.BigEndian.Uint16(input[offset+5 : offset+7]))
			if width == 0 || height == 0 {
				return 0, 0, errMalformedImage
			}
			return width, height, nil
		}
		offset += segmentLength
	}
	return 0, 0, errMalformedImage
}

func isJPEGStartOfFrame(marker byte) bool {
	switch marker {
	case 0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf:
		return true
	default:
		return false
	}
}

func inspectPNG(input []byte) (uint64, uint64, error) {
	if len(input) < 33 || !bytes.Equal(input[12:16], []byte("IHDR")) || binary.BigEndian.Uint32(input[8:12]) != 13 {
		return 0, 0, errMalformedImage
	}
	width := uint64(binary.BigEndian.Uint32(input[16:20]))
	height := uint64(binary.BigEndian.Uint32(input[20:24]))
	if width == 0 || height == 0 {
		return 0, 0, errMalformedImage
	}
	return width, height, nil
}

func inspectBMP(input []byte) (imageHeader, error) {
	if len(input) < 54 || !bytes.Equal(input[:2], []byte("BM")) {
		return imageHeader{}, errMalformedImage
	}
	dibSize := uint64(binary.LittleEndian.Uint32(input[14:18]))
	if dibSize < 40 || dibSize > uint64(len(input)-14) {
		return imageHeader{}, errMalformedImage
	}
	widthSigned := int64(int32(binary.LittleEndian.Uint32(input[18:22])))
	heightSigned := int64(int32(binary.LittleEndian.Uint32(input[22:26])))
	planes := binary.LittleEndian.Uint16(input[26:28])
	bitsPerPixel := binary.LittleEndian.Uint16(input[28:30])
	compression := binary.LittleEndian.Uint32(input[30:34])
	if widthSigned <= 0 || heightSigned == 0 || planes != 1 || (bitsPerPixel != 24 && bitsPerPixel != 32) || compression != 0 {
		return imageHeader{}, errMalformedImage
	}
	width := uint64(widthSigned)
	height := uint64(heightSigned)
	if heightSigned < 0 {
		height = uint64(-heightSigned)
	}
	maxInt := uint64(^uint(0) >> 1)
	if width > maxInt || height > maxInt {
		return imageHeader{}, errMalformedImage
	}
	bytesPerPixel := uint64(bitsPerPixel / 8)
	rowStride, ok := checkedMul((width*bytesPerPixel+3)/4, 4)
	if !ok {
		return imageHeader{}, errMalformedImage
	}
	pixelOffset := uint64(binary.LittleEndian.Uint32(input[10:14]))
	minimumOffset := uint64(14) + dibSize
	dataSize, ok := checkedMul(rowStride, height)
	if !ok || pixelOffset < minimumOffset || pixelOffset > uint64(len(input)) || dataSize > uint64(len(input))-pixelOffset {
		return imageHeader{}, errMalformedImage
	}
	return imageHeader{
		format: "bmp", width: width, height: height, frameWidth: width, frameHeight: height, frameCount: 1,
		totalFramePixels: width * height,
		bmp:              &bmpHeader{width: int(width), height: int(height), topDown: heightSigned < 0, pixelOffset: pixelOffset, rowStride: rowStride, bytesPerPixel: int(bytesPerPixel)},
	}, nil
}

func staticImageHeader(format string, width, height uint64) imageHeader {
	return imageHeader{
		format: format, width: width, height: height,
		frameWidth: width, frameHeight: height, frameCount: 1,
		totalFramePixels: width * height,
	}
}

func inspectGIF(input []byte) (imageHeader, error) {
	if len(input) < 13 {
		return imageHeader{}, errMalformedImage
	}
	width := uint64(binary.LittleEndian.Uint16(input[6:8]))
	height := uint64(binary.LittleEndian.Uint16(input[8:10]))
	if width == 0 || height == 0 {
		return imageHeader{}, errMalformedImage
	}
	offset := 13
	packed := input[10]
	if packed&0x80 != 0 {
		tableSize := 3 * (1 << ((packed & 0x07) + 1))
		if offset+tableSize > len(input) {
			return imageHeader{}, errMalformedImage
		}
		offset += tableSize
	}
	frames := 0
	maxFrameWidth, maxFrameHeight := width, height
	var duration int64
	var totalFramePixels uint64
	pendingDelay := int64(0)
	for offset < len(input) {
		block := input[offset]
		offset++
		switch block {
		case 0x3b:
			if frames == 0 {
				return imageHeader{}, errMalformedImage
			}
			return imageHeader{
				format: "gif", width: width, height: height,
				frameWidth: maxFrameWidth, frameHeight: maxFrameHeight, frameCount: frames,
				durationMS: duration, totalFramePixels: totalFramePixels,
			}, nil
		case 0x21:
			if offset >= len(input) {
				return imageHeader{}, errMalformedImage
			}
			label := input[offset]
			offset++
			if label == 0xf9 {
				if offset+6 > len(input) || input[offset] != 4 {
					return imageHeader{}, errMalformedImage
				}
				pendingDelay = int64(binary.LittleEndian.Uint16(input[offset+2:offset+4])) * 10
				offset += 5
				if offset >= len(input) || input[offset] != 0 {
					return imageHeader{}, errMalformedImage
				}
				offset++
				continue
			}
			var err error
			offset, err = skipGIFSubBlocks(input, offset)
			if err != nil {
				return imageHeader{}, err
			}
		case 0x2c:
			if offset+9 > len(input) {
				return imageHeader{}, errMalformedImage
			}
			frameWidth := uint64(binary.LittleEndian.Uint16(input[offset+4 : offset+6]))
			frameHeight := uint64(binary.LittleEndian.Uint16(input[offset+6 : offset+8]))
			if frameWidth == 0 || frameHeight == 0 {
				return imageHeader{}, errMalformedImage
			}
			if frameWidth > maxFrameWidth {
				maxFrameWidth = frameWidth
			}
			if frameHeight > maxFrameHeight {
				maxFrameHeight = frameHeight
			}
			localPacked := input[offset+8]
			offset += 9
			if localPacked&0x80 != 0 {
				tableSize := 3 * (1 << ((localPacked & 0x07) + 1))
				if offset+tableSize > len(input) {
					return imageHeader{}, errMalformedImage
				}
				offset += tableSize
			}
			if offset >= len(input) {
				return imageHeader{}, errMalformedImage
			}
			offset++
			var err error
			offset, err = skipGIFSubBlocks(input, offset)
			if err != nil {
				return imageHeader{}, err
			}
			frames++
			framePixels, ok := checkedMul(frameWidth, frameHeight)
			if !ok || totalFramePixels > math.MaxUint64-framePixels {
				totalFramePixels = math.MaxUint64
			} else {
				totalFramePixels += framePixels
			}
			if duration > math.MaxInt64-pendingDelay {
				duration = math.MaxInt64
			} else {
				duration += pendingDelay
			}
			pendingDelay = 0
		default:
			return imageHeader{}, errMalformedImage
		}
	}
	return imageHeader{}, errMalformedImage
}

func skipGIFSubBlocks(input []byte, offset int) (int, error) {
	for offset < len(input) {
		size := int(input[offset])
		offset++
		if size == 0 {
			return offset, nil
		}
		if size > len(input)-offset {
			return 0, errMalformedImage
		}
		offset += size
	}
	return 0, errMalformedImage
}

func inspectWebP(input []byte) (imageHeader, error) {
	if len(input) < 20 || binary.LittleEndian.Uint32(input[4:8]) < 4 {
		return imageHeader{}, errMalformedImage
	}
	riffSize := uint64(binary.LittleEndian.Uint32(input[4:8]))
	riffEnd := uint64(8) + riffSize
	if riffEnd > uint64(len(input)) {
		return imageHeader{}, errMalformedImage
	}
	end := int(riffEnd)
	offset := 12
	var width, height uint64
	var maxFrameWidth, maxFrameHeight uint64
	frames := 0
	var duration int64
	var totalFramePixels uint64
	animated := false
	for offset < end {
		if offset+8 > end {
			return imageHeader{}, errMalformedImage
		}
		chunkType := string(input[offset : offset+4])
		chunkSize := uint64(binary.LittleEndian.Uint32(input[offset+4 : offset+8]))
		offset += 8
		if chunkSize > uint64(end-offset) {
			return imageHeader{}, errMalformedImage
		}
		payload := input[offset : offset+int(chunkSize)]
		switch chunkType {
		case "VP8X":
			if len(payload) < 10 {
				return imageHeader{}, errMalformedImage
			}
			animated = payload[0]&0x02 != 0
			width = 1 + (uint64(payload[4]) | uint64(payload[5])<<8 | uint64(payload[6])<<16)
			height = 1 + (uint64(payload[7]) | uint64(payload[8])<<8 | uint64(payload[9])<<16)
			maxFrameWidth, maxFrameHeight = width, height
		case "VP8 ":
			if width == 0 || height == 0 {
				width, height = inspectVP8(payload)
				maxFrameWidth, maxFrameHeight = width, height
			}
		case "VP8L":
			if width == 0 || height == 0 {
				width, height = inspectVP8L(payload)
				maxFrameWidth, maxFrameHeight = width, height
			}
		case "ANMF":
			if len(payload) < 16 {
				return imageHeader{}, errMalformedImage
			}
			frames++
			frameWidth := 1 + (uint64(payload[6]) | uint64(payload[7])<<8 | uint64(payload[8])<<16)
			frameHeight := 1 + (uint64(payload[9]) | uint64(payload[10])<<8 | uint64(payload[11])<<16)
			if frameWidth > maxFrameWidth {
				maxFrameWidth = frameWidth
			}
			if frameHeight > maxFrameHeight {
				maxFrameHeight = frameHeight
			}
			framePixels, ok := checkedMul(frameWidth, frameHeight)
			if !ok || totalFramePixels > math.MaxUint64-framePixels {
				totalFramePixels = math.MaxUint64
			} else {
				totalFramePixels += framePixels
			}
			frameDuration := int64(uint64(payload[12]) | uint64(payload[13])<<8 | uint64(payload[14])<<16)
			if duration > math.MaxInt64-frameDuration {
				duration = math.MaxInt64
			} else {
				duration += frameDuration
			}
		}
		offset += int(chunkSize)
		if chunkSize&1 != 0 {
			if offset >= end {
				return imageHeader{}, errMalformedImage
			}
			offset++
		}
	}
	if offset != end {
		return imageHeader{}, errMalformedImage
	}
	if width == 0 || height == 0 {
		return imageHeader{}, errMalformedImage
	}
	if animated {
		if frames == 0 {
			return imageHeader{}, errMalformedImage
		}
	} else if frames > 0 {
		return imageHeader{}, errMalformedImage
	} else {
		frames = 1
		duration = 0
		totalFramePixels, _ = checkedMul(width, height)
		maxFrameWidth, maxFrameHeight = width, height
	}
	return imageHeader{
		format: "webp", width: width, height: height,
		frameWidth: maxFrameWidth, frameHeight: maxFrameHeight, frameCount: frames,
		durationMS: duration, totalFramePixels: totalFramePixels,
	}, nil
}

func inspectVP8(payload []byte) (uint64, uint64) {
	if len(payload) < 10 || payload[3] != 0x9d || payload[4] != 0x01 || payload[5] != 0x2a {
		return 0, 0
	}
	return uint64(binary.LittleEndian.Uint16(payload[6:8]) & 0x3fff), uint64(binary.LittleEndian.Uint16(payload[8:10]) & 0x3fff)
}

func inspectVP8L(payload []byte) (uint64, uint64) {
	if len(payload) < 5 || payload[0] != 0x2f {
		return 0, 0
	}
	bits := uint32(payload[1]) | uint32(payload[2])<<8 | uint32(payload[3])<<16 | uint32(payload[4])<<24
	return 1 + uint64(bits&0x3fff), 1 + uint64((bits>>14)&0x3fff)
}

func checkedMul(left, right uint64) (uint64, bool) {
	if left != 0 && right > math.MaxUint64/left {
		return 0, false
	}
	return left * right, true
}

func (h imageHeader) validate(kind Kind, limits Limits) *Error {
	if h.width == 0 || h.height == 0 || h.frameCount < 1 || h.durationMS < 0 {
		return decodeFailedError(kind, errMalformedImage)
	}
	if h.width > uint64(limits.MaxInputEdge) || h.height > uint64(limits.MaxInputEdge) {
		return dimensionsExceededError(kind, fmt.Errorf("dimensions=%dx%d", h.width, h.height))
	}
	if h.frameWidth == 0 {
		h.frameWidth = h.width
	}
	if h.frameHeight == 0 {
		h.frameHeight = h.height
	}
	if h.frameWidth > uint64(limits.MaxInputEdge) || h.frameHeight > uint64(limits.MaxInputEdge) {
		return dimensionsExceededError(kind, fmt.Errorf("frame dimensions=%dx%d", h.frameWidth, h.frameHeight))
	}
	pixels, ok := checkedMul(h.width, h.height)
	if !ok || pixels > uint64(limits.MaxInputPixels) {
		return dimensionsExceededError(kind, errors.New("decoded pixel budget exceeded"))
	}
	totalPixels, ok := checkedMul(pixels, uint64(h.frameCount))
	if !ok || totalPixels > uint64(limits.MaxInputPixels) {
		return dimensionsExceededError(kind, errors.New("animated decoded pixel budget exceeded"))
	}
	if h.totalFramePixels > uint64(limits.MaxInputPixels) {
		return dimensionsExceededError(kind, errors.New("frame pixel budget exceeded"))
	}
	if h.frameCount > limits.MaxFrames || h.durationMS > limits.MaxDurationMS {
		return animationTooComplexError(kind, errors.New("animation limits exceeded"))
	}
	return nil
}
