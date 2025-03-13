import {
  CoreApp,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  ScopedVars,
  AnnotationEvent,
  DataFrame,
  LiveChannelScope,
  FieldType,
} from '@grafana/data';
import { 
  getTemplateSrv,
  getGrafanaLiveSrv,
} from '@grafana/runtime';
import { Observable, from, merge, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { 
  MyQuery, 
  MyDataSourceOptions, 
  DEFAULT_QUERY,
  PRTGGroupListResponse,
  PRTGDeviceListResponse,
  PRTGSensorListResponse,
  PRTGChannelListResponse,
  QueryType,
} from './types';
import { PrtgApi } from './api';

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  url?: string;
  uid: string;
  prtgApi: PrtgApi;

  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>) {
    super(instanceSettings);
    this.url = instanceSettings.url;
    this.uid = instanceSettings.uid;
    this.prtgApi = new PrtgApi(instanceSettings);
  }

  getDefaultQuery(_: CoreApp): Partial<MyQuery> {
    return DEFAULT_QUERY;
  }

  applyTemplateVariables(query: MyQuery, scopedVars: ScopedVars) {
    const replaced = getTemplateSrv().replace(query.channel, scopedVars);
    return {
      ...query,
      channel: replaced,
    }
  }

  filterQuery(query: MyQuery): boolean {
    return !!query.channel;
  }

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    // Only handle streaming for metrics queries
    const streamingTargets = options.targets.filter(
      query => query.isStreaming && query.queryType === QueryType.Metrics
    );
    const regularTargets = options.targets.filter(
      query => !query.isStreaming || query.queryType !== QueryType.Metrics
    );
    
    const observables: Array<Observable<DataQueryResponse>> = [];

    // Process streaming targets
    if (streamingTargets.length > 0) {
      streamingTargets.forEach((query) => {
        // Create a unique, stable stream ID
        const streamId = this.getStreamId(query);
        const streamPath = `prtg-stream/${streamId}`;
        
        // Set up the data stream
        const streamObs = getGrafanaLiveSrv().getDataStream({
          addr: {
            scope: LiveChannelScope.DataSource,
            namespace: this.uid,
            path: streamPath,
            data: {
              ...query,
              streamId,
              panelId: options.panelId?.toString(),
              queryId: query.refId,
              timeRange: {
                from: options.range.from.valueOf(),
                to: options.range.to.valueOf(),
              },
              // Use provided values or defaults
              cacheTime: query.cacheTime,
              updateMode: query.updateMode,
              bufferSize: query.bufferSize,
            },
          },
        }).pipe(
          map((response: any) => {
            // Enhance frame with streaming metadata
            const frameData = response.data || [];
            frameData.forEach((frame) => {
              if (frame && frame.meta) {
                frame.meta = {
                  ...frame.meta,
                  streaming: true,
                  streamId,
                  preferredVisualisationType: 'graph',
                };
              }
            });
            return { data: frameData };
          }),
          catchError((err) => {
            console.error('Stream error:', err);
            return throwError(() => new Error(`Streaming error: ${err.message || 'Unknown error'}`));
          })
        );
        
        observables.push(streamObs);
      });
    }

    // Process regular targets
    if (regularTargets.length > 0) {
      // Transform each query to fetch data using PrtgApi
      const promises = regularTargets.map(async (target) => {
        const { range } = options;
        
        if (target.queryType === QueryType.Metrics && target.sensorId) {
          try {
            const startDate = range.from.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const endDate = range.to.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            
            // Use the API to get sensor history
            const histData = await this.prtgApi.getSensorHistory(
              Number(target.sensorId), 
              startDate, 
              endDate
            );
            
            if (!histData.length) {
                return { refId: target.refId, data: [] };
            }
            
            // Process data into Grafana DataFrame format
            const times: number[] = [];
            const values: Record<string, number[]> = {};
            const channelLabels: Record<string, string> = {};
            
            const histDataArray = Array.isArray(histData) ? histData : [];
            histDataArray.forEach((item: any) => {
                if (item.datetime) {
                    const time = new Date(item.datetime).getTime();
                    times.push(time);
                    
                    // Extract values for each channel
                    Object.entries(item).forEach(([key, value]) => {
                        if (key !== 'datetime') {
                            if (!values[key]) {
                                values[key] = [];
                                channelLabels[key] = key;
                            }
                            values[key].push(typeof value === 'number' ? value : parseFloat(value as string) || 0);
                        }
                    });
                }
            });
            
            // Create one frame per channel
            const frames = Object.keys(values).map(channel => {
                let name = channelLabels[channel];
                
                // Add prefix based on user preferences
                const prefixParts = [];
                if (target.includeGroupName && target.group) prefixParts.push(target.group);
                if (target.includeDeviceName && target.device) prefixParts.push(target.device);
                if (target.includeSensorName && target.sensor) prefixParts.push(target.sensor);
                
                const prefix = prefixParts.length > 0 ? prefixParts.join(' - ') + ' - ' : '';
                name = prefix + name;

                return {
                    refId: target.refId,
                    name,
                    fields: [
                        { name: 'Time', values: times, type: FieldType.time },
                        { name: 'Value', values: values[channel], type: FieldType.number },
                    ],
                };
            });
            
            return { refId: target.refId, data: frames };
            
          } catch (error) {
            console.error('Error fetching sensor history:', error);
            return { refId: target.refId, data: [] };
          }
        }
        
        return { refId: target.refId, data: [] };
      });
      
      try {
        const results = await Promise.all(promises);
        const frames = results.flatMap(r => r.data);
        observables.push(from([{ data: frames }]));
      } catch (err) {
        console.error('Query error:', err);
        observables.push(throwError(() => new Error(`Query error: ${err}`)));
      }
    }

    // Combine all observables
    return observables.length ? merge(...observables) : from([{ data: [] }]);
  }

  // Improved stream ID generation for better stability
  private getStreamId(query: MyQuery): string {
    const components = [
      query.panelId || 'default',
      query.refId || 'A',
      query.sensorId || '',
      Array.isArray(query.channelArray) ? query.channelArray.join('-') : query.channel || '',
    ];
    return components.filter(Boolean).join('_');
  }

  async getGroups(): Promise<PRTGGroupListResponse> {
    const items = await this.prtgApi.getGroupList();
    return {
      prtgversion: '',
      treesize: items.length,
      groups: items
    };
  }

  async getDevices(group: string): Promise<PRTGDeviceListResponse> {
    if (!group) {
      throw new Error('group is required');
    }
    const items = await this.prtgApi.getDevices(group);
    return {
      prtgversion: '',
      treesize: items.length,
      devices: items
    };
  }

  async getSensors(device: string): Promise<PRTGSensorListResponse> {
    if (!device) {
      throw new Error('device is required');
    }
    const items = await this.prtgApi.getSensors(device);
    const sensorsArray = Array.isArray(items) ? items : [items].filter(Boolean);
    return {
      prtgversion: '',
      treesize: sensorsArray.length,
      sensors: sensorsArray
    };
  }

  async getChannels(sensorId: string): Promise<PRTGChannelListResponse> {
    if (!sensorId) {
      throw new Error('sensorId is required');
    }
    const channels = await this.prtgApi.getChannels(sensorId);
    const channelsArray = Array.isArray(channels) ? channels : [channels].filter(Boolean);
    return {
      prtgversion: '',
      treesize: channelsArray.length,
      values: channelsArray
    };
  }

  // Stream control methods
  async getStreamStatus(streamId: string): Promise<any> {
    // Implement using API if needed
    return { status: "unknown", streamId };
  }

  async stopStream(streamId: string): Promise<void> {
    // Implement using API if needed
  }

  /**
   * Gets annotation data for the given query
   */
  async getAnnotations(query: {
    sensorId: string;
    from: number;
    to: number;
    limit?: number;
  }): Promise<any> {
    // Convert timestamps to date strings
    const fromTime = new Date(query.from);
    const toTime = new Date(query.to);
    
    // Format dates for PRTG API
    const fromStr = fromTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const toStr = toTime.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    
    // Calculate time range for avg parameter
    const hours = (toTime.getTime() - fromTime.getTime()) / (1000 * 60 * 60);
    let avg = '0';
    if (hours > 720) {
        avg = '86400';
    } else if (hours > 336) {
        avg = '3600';
    } else if (hours > 168) {
        avg = '1800';
    } else if (hours > 72) {
        avg = '900';
    } else if (hours > 48) {
        avg = '600';
    } else if (hours > 24) {
        avg = '300';
    } else if (hours > 12) {
        avg = '120';
    }
    
    const params = {
        id: query.sensorId,
        avg: avg,
        sdate: fromStr,
        edate: toStr,
        columns: 'datetime,value_',
        usecaption: '1',
        count: '50000'
    };

    try {
        const response = await this.prtgApi.getSensorHistory(
          Number(query.sensorId), 
          fromStr, 
          toStr
        );
        const histData = response || [];
        
        // Transform to Grafana annotation format
        const annotationsData = Array.isArray(histData) ? histData : [];
        const annotations = annotationsData.map((data, i) => {
            const time = new Date(data.datetime).getTime();
            
            return {
                id: `uid:${query.sensorId}_${i}`,
                time: time,
                timeEnd: time,
                title: `Sensor: ${query.sensorId}`,
                tags: ['prtg', `sensor:${query.sensorId}`],
                type: 'annotation',
                data: data.value_,
            };
        });
        
        // Apply limit if specified
        const limitedAnnotations = query.limit && query.limit > 0 
            ? annotations.slice(0, query.limit)
            : annotations;
        
        return {
            annotations: limitedAnnotations,
            total: limitedAnnotations.length,
        };
    } catch (error) {
        console.error('Error fetching annotations:', error);
        throw error;
    }
  }

  annotations = {
    QueryEditor: undefined,
    processEvents: (anno: any, data: DataFrame[]): Observable<AnnotationEvent[]> => {
      const events: AnnotationEvent[] = [];
      
      data.forEach((frame) => {
        const timeField = frame.fields.find((field) => field.name === 'Time');
        const valueField = frame.fields.find((field) => field.name === 'Value');
        
        if (timeField && valueField) {
          const firstTime = timeField.values[0];
          const lastTime = timeField.values[timeField.values.length - 1];
          const firstValue = valueField.values[0];
          const panelId = typeof anno.panelId === 'number' ? anno.panelId : undefined;
          const source = frame.name || 'PRTG Channel';

          events.push({
            time: firstTime,
            timeEnd: lastTime !== firstTime ? lastTime : undefined,
            title: source,
            text: `Value: ${firstValue}`,
            tags: ['prtg', `value:${firstValue}`, `source:${source}`],
            panelId: panelId
          });
        }
      });

      return from([events]);
    },
  };

  /**
   * Checks whether we can connect to the API.
   */
  async testDatasource() {
    try {
      const status = await this.prtgApi.getStatusList();
      if (status) {
        return {
          status: 'success',
          message: 'Success - Connected to PRTG Server',
        };
      } else {
        return {
          status: 'error',
          message: 'Failed to connect to PRTG Server',
        };
      }
    } catch (err) {
      let message = 'Error connecting to PRTG Server';
      if (err instanceof Error) {
        message += `: ${err.message}`;
      }
      return {
        status: 'error',
        message,
      };
    }
  }
}
