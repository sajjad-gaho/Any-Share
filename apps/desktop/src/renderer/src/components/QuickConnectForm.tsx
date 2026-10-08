import { zodResolver } from '@hookform/resolvers/zod';
import { deviceIdSchema, formatDeviceId } from '@remote-desktop/shared';
import { Button, FieldError, Input, Label } from '@remote-desktop/ui';
import { ArrowRight } from 'lucide-react';
import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';

const quickConnectSchema = z.object({ deviceId: deviceIdSchema });
type QuickConnectInput = z.input<typeof quickConnectSchema>;
type QuickConnectOutput = z.output<typeof quickConnectSchema>;

export function QuickConnectForm() {
  const navigate = useNavigate();
  const inputId = useId();
  const errorId = useId();
  const { control, handleSubmit } = useForm<QuickConnectInput, unknown, QuickConnectOutput>({
    resolver: zodResolver(quickConnectSchema),
    defaultValues: { deviceId: '' },
  });

  const onSubmit = handleSubmit(({ deviceId }) => {
    void navigate(`/session/${deviceId}`);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-2">
      <Label htmlFor={inputId}>Remote device ID</Label>
      <Controller
        control={control}
        name="deviceId"
        render={({ field, fieldState }) => (
          <>
            <div className="flex gap-2">
              <Input
                {...field}
                id={inputId}
                onChange={(event) => field.onChange(formatDeviceId(event.target.value))}
                placeholder="123 456 789"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={11}
                aria-invalid={fieldState.invalid}
                aria-describedby={fieldState.error ? errorId : undefined}
                className="h-11 font-mono text-lg tracking-wider"
              />
              <Button type="submit" size="lg" className="h-11">
                Connect
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
            <FieldError id={errorId}>{fieldState.error?.message}</FieldError>
          </>
        )}
      />
    </form>
  );
}
