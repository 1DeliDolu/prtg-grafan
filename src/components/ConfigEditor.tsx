import React, { ChangeEvent, useState } from 'react';
import { InlineField, Input, SecretInput } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { MyDataSourceOptions, MySecureJsonData } from '../types';

interface Props extends DataSourcePluginOptionsEditorProps<MyDataSourceOptions, MySecureJsonData> {}

export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;
  const [cache, setCache] = useState(jsonData.cache || '');
  const [error, setError] = useState('');

  const onPathChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        path: event.target.value,
      },
    });
  };

  const onCacheChange = (event: ChangeEvent<HTMLInputElement>) => {
    const cache_timeout = parseInt(event.target.value, 10);
    
    if (cache_timeout > 0 && cache_timeout <= 1440) {
      const jsonData = {
        ...options.jsonData,
        cache: cache_timeout,
      };
      setCache(cache_timeout);
      setError('');
      onOptionsChange({ ...options, jsonData });
    } else {
      const jsonData = {
        ...options.jsonData,
        cache: 5
      };
      setCache('');
      onOptionsChange({ ...options, jsonData });
      setError('Cache timeout should be a number between 1 and 1440. It will default to 5 if not set.');
    }
  };

  const onApiTokenChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      secureJsonData: {
        ...secureJsonData,
        apiToken: event.target.value,
      },
    });
  };

  const onResetApiToken = () => {
    onOptionsChange({
      ...options,
      secureJsonFields: {
        ...secureJsonFields,
        apiToken: false,
      },
      secureJsonData: {
        ...secureJsonData,
        apiToken: '',
      },
    });
  };

 
  const styles = {
    error: {
      paddingLeft: '165px',
      paddingTop: '8px',
      fontSize: '10px', 
      color: 'red'
    },
  };

  return (
    <div className="gf-form-group">
      <InlineField label="Path" labelWidth={20}>
        <Input
          id="config-editor-path"
          onChange={onPathChange}
          value={jsonData.path || ''}
          placeholder="Enter the path"
          width={40}
        />
      </InlineField>
      
      <InlineField label="API Token" labelWidth={20}>
        <SecretInput
          required
          isConfigured={secureJsonFields.apiToken}
          value={secureJsonData?.apiToken}
          placeholder="Enter your API token"
          width={40}
          onReset={onResetApiToken}
          onChange={onApiTokenChange}
        />
      </InlineField>
      <InlineField label="Cache timeout" labelWidth={20}>
        <Input
          id="config-editor-cache"
          onChange={onCacheChange}
          value={cache}
          placeholder="Timeout in minutes"
          width={40}
        />
      </InlineField>
      <div>
        <p style={styles.error} id="age-error">{error}</p>
      </div>
    </div>
  );
}
