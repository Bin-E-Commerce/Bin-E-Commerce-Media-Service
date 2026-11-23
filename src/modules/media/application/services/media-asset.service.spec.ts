import { PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaAssetService } from '@/modules/media/application/services/media-asset.service';

describe('MediaAssetService image indexing download cap', () => {
    let target: MediaAssetService;
    let mockSend: jest.Mock;

    // Cài S3 fake để kiểm tra preflight size mà không gọi object storage thật.
    beforeEach(() => {
        const mockConfig = {
            get: jest.fn((key: string, fallback?: string) =>
                key === 'AWS_S3_BUCKET' ? 'test-bucket' : fallback,
            ),
        } as unknown as ConfigService;
        target = new MediaAssetService(mockConfig);
        mockSend = jest.fn();
        Object.defineProperty(target, 's3', { value: { send: mockSend } });
    });

    // Asset catalog vượt 8 MiB bị từ chối trước transformToByteArray để không tạo Buffer lớn.
    it('should reject oversized product image before buffering the S3 body', async () => {
        // Arrange
        const destroy = jest.fn();
        const body = {
            destroy,
            transformToByteArray: jest.fn(),
        };
        mockSend
            .mockResolvedValueOnce({
                Contents: [
                    {
                        Key: 'uploads/original/product_image/owner/asset/image.webp',
                    },
                ],
                IsTruncated: false,
            })
            .mockResolvedValueOnce({
                ContentLength: 8 * 1024 * 1024 + 1,
                Body: body,
            });

        // Act
        const result = target.downloadInternalAsset(
            'owner-id',
            'asset-id',
            'product_image',
        );

        // Assert
        await expect(result).rejects.toBeInstanceOf(PayloadTooLargeException);
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(body.transformToByteArray).not.toHaveBeenCalled();
    });
});
