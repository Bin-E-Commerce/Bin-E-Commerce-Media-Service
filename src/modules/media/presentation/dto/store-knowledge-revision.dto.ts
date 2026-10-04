import { IsString, MaxLength, MinLength } from 'class-validator';

// DTO giới hạn request text để endpoint nội bộ không trở thành đường upload file tùy ý.
export class StoreKnowledgeRevisionDto {
    @IsString()
    @MinLength(1)
    @MaxLength(65_536)
    markdown: string;
}
