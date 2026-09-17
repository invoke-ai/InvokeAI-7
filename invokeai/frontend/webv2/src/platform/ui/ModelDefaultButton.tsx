import { Icon } from '@chakra-ui/react';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { RotateCcwIcon } from 'lucide-react';
import { useCallback } from 'react';

/**
 * Reset-to-default affordance. Callers render it only while the value
 * differs from the default, so its presence itself signals "modified". No
 * fallback label: every call site knows what it's resetting and says so.
 */
export const ModelDefaultButton = ({ label, onClick }: { label: string; onClick: () => void }) => {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    },
    [onClick]
  );

  return (
    <Tooltip content={label}>
      <IconButton aria-label={label} color="fg.muted" size="2xs" variant="ghost" onClick={handleClick}>
        <Icon as={RotateCcwIcon} boxSize="2.5" />
      </IconButton>
    </Tooltip>
  );
};
