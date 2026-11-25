// Kiểm tra giới hạn tải ảnh catalog bằng S3 giả để không truy cập object storage.
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaAssetService } from '@/modules/media/application/services/assets/media-asset.service';

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

    // Asset không tồn tại ở cả prefix gốc và prefix AI fallback là 404 xác định, không phải lỗi storage tạm thời.
    it('should return not found when no owner-scoped source object exists', async () => {
        // Arrange
        mockSend
            .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
            .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

        // Act
        const result = target.downloadInternalAsset(
            'owner-id',
            'asset-id',
            'product_image',
        );

        // Assert
        await expect(result).rejects.toBeInstanceOf(NotFoundException);
        expect(mockSend).toHaveBeenCalledTimes(2);
    });
});
